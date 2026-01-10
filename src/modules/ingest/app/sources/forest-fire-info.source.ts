import { z } from 'zod';
import { logger } from '@/core/logger';
import { EventKinds, EventLevels, EventSources } from '@/modules/events/domain/event.enums';
import type { Source, SourceEvent, SourceRunResult } from '../../domain/port/source.interface';
import { fetchWithTimeout } from './_shared/fetch-with-timeout';
import { isTooOld } from './_shared/is-too-old';
import { normalizeText } from './_shared/normalize';
import { pruneTimedMap } from './_shared/prune-timed-map';
import { shouldEmitEvent } from './_shared/should-emit-event';

const FOREST_FIRE_INFO_ENDPOINT = 'https://fd.forest.go.kr/ffas/pubConn/occur/getPublicShowFireInfoList.do';
const KST_OFFSET_MS = 9 * 60 * 60 * 1000;
const STATE_RANGE_DAYS = 7;
const STATE_TTL_MS = 1000 * 60 * 60 * 24 * STATE_RANGE_DAYS;
const EVENT_MAX_AGE_MS = STATE_TTL_MS * 0.9;

const schemaForestFireItem = z.object({
  frfr_lctn_xcrd: z.string().nullable().optional(),
  frfr_prgrs_stcd_str: z.string().nullable().optional(),
  potfr_end_dtm: z.string().nullable().optional(),
  frfr_info_id: z.string().nullable().optional(),
  frfr_prgrs_stcd: z.string().nullable().optional(),
  frfr_lctn_ycrd: z.string().nullable().optional(),
  frfr_sttmn_addr: z.string().nullable().optional(),
  frfr_step_issu_cd: z.string().nullable().optional(),
  frfr_sttmn_dt: z.string().nullable().optional(),
  frfr_frng_dtm: z.string().nullable().optional(),
});

const schemaForestFireResponse = z.object({
  pager: z
    .object({
      total_count: z.number().optional(),
      last_page: z.number().optional(),
    })
    .optional(),
  frfrInfoList: z.array(schemaForestFireItem).optional().default([]),
});

type ForestFireItem = z.infer<typeof schemaForestFireItem>;

type ForestFireState = {
  seen: Record<string, string>;
  highLevelSent: Record<string, HighLevelEntry>;
};

type HighLevelEntry = {
  level: EventLevels;
  seenAt: string;
};

type ProgressStatus = 'reported' | 'in_progress' | 'completed' | 'not_fire' | 'unknown';

export class ForestFireInfoSource implements Source {
  public readonly sourceId = EventSources.ForestFireInfo;
  public readonly pollIntervalSec = 60 * 5;

  public async run(state: string | null): Promise<SourceRunResult> {
    const { startDate, endDate } = getKstDateRange(STATE_RANGE_DAYS);
    const payload = buildRequestBody(startDate, endDate);

    const response = await fetchWithTimeout({
      url: FOREST_FIRE_INFO_ENDPOINT,
      init: {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json;charset=UTF-8',
          Accept: 'application/json',
        },
        body: JSON.stringify(payload),
      },
    });

    if (!response) {
      throw new Error('Forest fire info request failed');
    }

    const data = await response.json();

    const parsed = schemaForestFireResponse.safeParse(data);
    if (!parsed.success) {
      logger.warn({ error: parsed.error }, 'Failed to parse forest fire info response');
      throw new Error('Failed to parse forest fire info response');
    }

    const previousState = parseState(state);
    const seen = new Map<string, string>(Object.entries(previousState.seen));
    const seenFireIds = buildSeenFireIdSet(seen);
    const highLevelSent = new Map<string, HighLevelEntry>(Object.entries(previousState.highLevelSent));
    const now = new Date();
    const nowMs = now.getTime();
    const nowIso = now.toISOString();

    const events: SourceEvent[] = [];

    for (const item of parsed.data.frfrInfoList) {
      const fireId = normalizeText(item.frfr_info_id);
      if (!fireId) {
        continue;
      }

      const progressLabel = resolveProgressLabel(item);
      const progressStatus = resolveProgressStatus(progressLabel);
      const stepLabel = normalizeText(item.frfr_step_issu_cd);
      const baseLevel = isStepLevelEnabled(progressStatus) ? mapStepLevel(stepLabel) : EventLevels.Info;
      const uniqueKey = buildUniqueKey(fireId, progressStatus, stepLabel);

      const resolvedOccurredAt = resolveOccurredAt(item);
      const occurredAt = seenFireIds.has(fireId) ? nowIso : resolvedOccurredAt;
      if (isTooOld(occurredAt, nowMs, EVENT_MAX_AGE_MS)) {
        continue;
      }

      const lastHighLevel = getLastHighLevel(highLevelSent, fireId, nowMs);
      const shouldBoost = baseLevel !== EventLevels.Info && (lastHighLevel === null || baseLevel > lastHighLevel);
      const level = shouldBoost ? baseLevel : EventLevels.Info;

      if (shouldEmitEvent(seen.get(uniqueKey), nowMs, STATE_TTL_MS)) {
        events.push(buildEvent(item, occurredAt, progressLabel, stepLabel, level));
      }

      if (baseLevel !== EventLevels.Info) {
        const nextLevel = lastHighLevel === null ? baseLevel : pickHigherLevel(lastHighLevel, baseLevel);
        highLevelSent.set(fireId, { level: nextLevel, seenAt: nowIso });
      }

      seen.set(uniqueKey, nowIso);
      seenFireIds.add(fireId);
    }

    pruneTimedMap(seen, nowMs, STATE_TTL_MS);
    pruneHighLevelMap(highLevelSent, nowMs);
    const nextState = buildState(seen, highLevelSent);

    return { events, nextState };
  }
}

const buildEvent = (
  item: ForestFireItem,
  occurredAt: string | null,
  progressLabel: string | null,
  stepLabel: string | null,
  level: EventLevels,
): SourceEvent => {
  const regionText = normalizeText(item.frfr_sttmn_addr);
  const title = buildTitle(regionText, progressLabel, stepLabel);
  const geo = resolveGeo(item);

  return {
    kind: EventKinds.Wildfire,
    title,
    body: buildBody(item, regionText, progressLabel, stepLabel),
    occurredAt,
    regionText,
    geo,
    level,
    payload: item,
  };
};

const buildTitle = (regionText: string | null, progressLabel: string | null, stepLabel: string | null): string => {
  const prefix = regionText ? extractRegionPrefix(regionText) : null;
  const status = progressLabel ?? stepLabel ?? '발생';
  const parts = [prefix, '산불', status].filter((value): value is string => Boolean(value));

  const resolvedStep = stepLabel && progressLabel && !progressLabel.includes(stepLabel) ? `(${stepLabel})` : null;
  if (resolvedStep) {
    parts.push(resolvedStep);
  }

  return parts.join(' ').trim() || '산불 발생 정보';
};

const buildBody = (
  item: ForestFireItem,
  regionText: string | null,
  progressLabel: string | null,
  stepLabel: string | null,
): string | null => {
  const lines: string[] = [];

  if (regionText) {
    lines.push(`주소: ${regionText}`);
  }

  if (progressLabel) {
    lines.push(`진행 상태: ${progressLabel}`);
  }

  if (stepLabel) {
    lines.push(`대응 단계: ${stepLabel}`);
  }

  const fireAt = normalizeText(item.frfr_frng_dtm);
  if (fireAt) {
    lines.push(`발생 시각: ${fireAt}`);
  }

  const endAt = normalizeText(item.potfr_end_dtm);
  if (endAt) {
    lines.push(`진화 시각: ${endAt}`);
  }

  return lines.length > 0 ? lines.join('\n') : null;
};

const buildUniqueKey = (fireId: string, progressStatus: ProgressStatus, stepLabel: string | null): string => {
  const progressKey = progressStatus;
  const stepKey = stepLabel ?? 'unknown';

  return `${fireId}|${progressKey}|${stepKey}`;
};

function buildSeenFireIdSet(seen: Map<string, string>): Set<string> {
  const seenFireIds = new Set<string>();
  for (const key of seen.keys()) {
    const fireId = extractFireIdFromKey(key);
    if (fireId) {
      seenFireIds.add(fireId);
    }
  }
  return seenFireIds;
}

function extractFireIdFromKey(key: string): string | null {
  const trimmed = key.trim();
  if (!trimmed) {
    return null;
  }

  const [fireId] = trimmed.split('|');
  const normalized = fireId?.trim();
  return normalized ? normalized : null;
}

const resolveOccurredAt = (item: ForestFireItem): string | null => {
  const occurredAt = parseKstDateTime(item.frfr_frng_dtm);
  if (occurredAt) {
    return occurredAt;
  }

  return parseKstDate(item.frfr_sttmn_dt);
};

const resolveProgressLabel = (item: ForestFireItem): string | null => {
  return normalizeText(item.frfr_prgrs_stcd_str) ?? normalizeText(item.frfr_prgrs_stcd);
};

const resolveProgressStatus = (progressLabel: string | null): ProgressStatus => {
  const normalized = normalizeText(progressLabel);
  if (!normalized) {
    return 'unknown';
  }

  if (isInProgressStatus(normalized)) {
    return 'in_progress';
  }
  if (isCompletedStatus(normalized)) {
    return 'completed';
  }
  if (isReportedStatus(normalized)) {
    return 'reported';
  }
  if (isNotFireStatus(normalized)) {
    return 'not_fire';
  }

  return 'unknown';
};

const isStepLevelEnabled = (progressStatus: ProgressStatus): boolean => {
  return progressStatus === 'reported' || progressStatus === 'in_progress';
};

const mapStepLevel = (stepLabel: string | null): EventLevels => {
  const normalized = normalizeText(stepLabel);
  if (!normalized) {
    return EventLevels.Info;
  }

  if (normalized.includes('3단계')) {
    return EventLevels.Critical;
  }
  if (normalized.includes('2단계')) {
    return EventLevels.Severe;
  }
  if (normalized.includes('1단계')) {
    return EventLevels.Moderate;
  }
  if (normalized.includes('초기')) {
    return EventLevels.Minor;
  }

  return EventLevels.Info;
};

const pickHigherLevel = (first: EventLevels, second: EventLevels): EventLevels => {
  return first > second ? first : second;
};

const isReportedStatus = (value: string): boolean => {
  return value.includes('신고') || value.includes('접수');
};

const isInProgressStatus = (value: string): boolean => {
  return value.includes('진화중');
};

const isCompletedStatus = (value: string): boolean => {
  return value.includes('진화완료');
};

const isNotFireStatus = (value: string): boolean => {
  return value.includes('외') || value.includes('종료');
};

const extractRegionPrefix = (regionText: string): string => {
  const trimmed = regionText.trim();
  if (!trimmed) {
    return regionText;
  }

  const [first] = trimmed.split(/\s+/);
  return first ?? regionText;
};

const parseCoordinate = (value: string | null | undefined): number | null => {
  if (!value) {
    return null;
  }

  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
};

const resolveGeo = (item: ForestFireItem): { lat: number; lng: number } | null => {
  const lng = parseCoordinate(item.frfr_lctn_xcrd);
  const lat = parseCoordinate(item.frfr_lctn_ycrd);

  if (lng === null || lat === null) {
    return null;
  }

  return { lat, lng };
};

const parseKstDateTime = (value: string | null | undefined): string | null => {
  const normalized = normalizeText(value);
  if (!normalized) {
    return null;
  }

  const matched = normalized.match(/^(\d{4})-(\d{2})-(\d{2})\s+(\d{2}):(\d{2})(?::(\d{2}))?$/);
  if (!matched) {
    return null;
  }

  const [, year, month, day, hour, minute, second] = matched;
  const kstIso = `${year}-${month}-${day}T${hour}:${minute}:${second ?? '00'}+09:00`;
  const parsed = new Date(kstIso);
  if (Number.isNaN(parsed.getTime())) {
    return null;
  }

  return parsed.toISOString();
};

const parseKstDate = (value: string | null | undefined): string | null => {
  const normalized = normalizeText(value);
  if (!normalized) {
    return null;
  }

  const matched = normalized.match(/^(\d{4})(\d{2})(\d{2})$/);
  if (!matched) {
    return null;
  }

  const [, year, month, day] = matched;
  const kstIso = `${year}-${month}-${day}T00:00:00+09:00`;
  const parsed = new Date(kstIso);
  if (Number.isNaN(parsed.getTime())) {
    return null;
  }

  return parsed.toISOString();
};

const pruneHighLevelMap = (items: Map<string, HighLevelEntry>, nowMs: number): void => {
  for (const [key, value] of items) {
    const parsed = Date.parse(value.seenAt);
    if (!Number.isFinite(parsed) || nowMs - parsed > STATE_TTL_MS) {
      items.delete(key);
    }
  }
};

const getLastHighLevel = (
  highLevelSent: Map<string, HighLevelEntry>,
  fireId: string,
  nowMs: number,
): EventLevels | null => {
  const entry = highLevelSent.get(fireId);
  if (!entry) {
    return null;
  }

  const parsed = Date.parse(entry.seenAt);
  if (!Number.isFinite(parsed) || nowMs - parsed > STATE_TTL_MS) {
    highLevelSent.delete(fireId);
    return null;
  }

  return entry.level;
};

const parseState = (state: string | null): ForestFireState => {
  if (!state) {
    return { seen: {}, highLevelSent: {} };
  }

  try {
    const parsed = JSON.parse(state) as { seen?: unknown; highLevelSent?: unknown };
    if (!parsed || typeof parsed !== 'object') {
      return { seen: {}, highLevelSent: {} };
    }

    return {
      seen: parseStateRecord(parsed.seen),
      highLevelSent: parseHighLevelStateRecord(parsed.highLevelSent),
    };
  } catch (error) {
    logger.warn({ error }, 'Failed to parse forest fire info checkpoint state');
    return { seen: {}, highLevelSent: {} };
  }
};

const parseStateRecord = (value: unknown): Record<string, string> => {
  if (!value || typeof value !== 'object') {
    return {};
  }

  const result: Record<string, string> = {};
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    const trimmedKey = key.trim();
    if (trimmedKey && typeof entry === 'string') {
      result[trimmedKey] = entry;
    }
  }

  return result;
};

const parseHighLevelStateRecord = (value: unknown): Record<string, HighLevelEntry> => {
  if (!value || typeof value !== 'object') {
    return {};
  }

  const result: Record<string, HighLevelEntry> = {};
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    const trimmedKey = key.trim();
    if (!trimmedKey || !entry || typeof entry !== 'object') {
      continue;
    }

    const parsed = parseHighLevelEntry(entry);
    if (parsed) {
      result[trimmedKey] = parsed;
    }
  }

  return result;
};

const parseHighLevelEntry = (value: object): HighLevelEntry | null => {
  const { level, seenAt } = value as { level?: unknown; seenAt?: unknown };
  if (typeof level !== 'number' || typeof seenAt !== 'string') {
    return null;
  }

  if (!Number.isFinite(level) || level < EventLevels.Info || level > EventLevels.Critical) {
    return null;
  }

  if (!seenAt.trim()) {
    return null;
  }

  return { level: level as EventLevels, seenAt };
};

const buildState = (seen: Map<string, string>, highLevelSent: Map<string, HighLevelEntry>): string | null => {
  if (seen.size === 0 && highLevelSent.size === 0) {
    return null;
  }

  const seenPayload: Record<string, string> = {};
  for (const [key, value] of seen) {
    seenPayload[key] = value;
  }

  const highLevelPayload: Record<string, HighLevelEntry> = {};
  for (const [key, value] of highLevelSent) {
    highLevelPayload[key] = {
      level: value.level,
      seenAt: value.seenAt,
    };
  }

  return JSON.stringify({ seen: seenPayload, highLevelSent: highLevelPayload });
};

const getKstDateRange = (daysBack: number): { startDate: string; endDate: string } => {
  const nowKst = new Date(Date.now() + KST_OFFSET_MS);
  const endDate = formatCompactDate(nowKst);
  const startKst = new Date(nowKst);
  startKst.setUTCDate(startKst.getUTCDate() - daysBack);
  return {
    startDate: formatCompactDate(startKst),
    endDate,
  };
};

const formatCompactDate = (date: Date): string => {
  const year = date.getUTCFullYear();
  const month = String(date.getUTCMonth() + 1).padStart(2, '0');
  const day = String(date.getUTCDate()).padStart(2, '0');
  return `${year}${month}${day}`;
};

const buildRequestBody = (startDate: string, endDate: string) => {
  const perPage = '30';

  return {
    param: {
      startDtm: startDate,
      endDtm: endDate,
      regionCode: '',
      issuCode: '',
      prgrsCode: '',
      sttnMapCheckFlag: '',
      perPage,
      perPageList: 10,
      pageListStart: 0,
      pageListEnd: 10,
      currentPage: 1,
      lastPage: 0,
      totalCount: 0,
      total_count: 0,
      last_page: 0,
    },
    pager: {
      perPage,
      perPageList: 10,
      pageListStart: 0,
      pageListEnd: 10,
      currentPage: 1,
      lastPage: 0,
      totalCount: 0,
      total_count: 0,
      last_page: 0,
    },
  };
};
