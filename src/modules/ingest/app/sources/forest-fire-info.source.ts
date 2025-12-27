import { z } from 'zod';
import { logger } from '@/core/logger';
import type { EventPayload } from '@/modules/events/domain/entity/event.entity';
import { EventKinds, EventLevels, EventSources } from '@/modules/events/domain/event.enums';
import type { Source, SourceEvent, SourceRunResult } from '../../domain/port/source.interface';

const FOREST_FIRE_INFO_ENDPOINT = 'https://fd.forest.go.kr/ffas/pubConn/occur/getPublicShowFireInfoList.do';
const REQUEST_TIMEOUT_MS = 10000;
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

    const response = await fetchWithTimeout(FOREST_FIRE_INFO_ENDPOINT, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json;charset=UTF-8',
        Accept: 'application/json',
      },
      body: JSON.stringify(payload),
    });

    if (!response) {
      return { events: [], nextState: state };
    }

    const data = await parseJsonResponse(response, this.sourceId);
    if (!data) {
      return { events: [], nextState: state };
    }

    const parsed = schemaForestFireResponse.safeParse(data);
    if (!parsed.success) {
      logger.warn({ error: parsed.error }, 'Failed to parse forest fire info response');
      return { events: [], nextState: state };
    }

    const previousState = parseState(state);
    const seen = new Map<string, string>(Object.entries(previousState.seen));
    const highLevelSent = new Map<string, HighLevelEntry>(Object.entries(previousState.highLevelSent));
    const now = new Date();
    const nowMs = now.getTime();
    const nowIso = now.toISOString();

    const events: SourceEvent[] = [];

    for (const item of parsed.data.frfrInfoList) {
      const fireId = normalizeOptionalText(item.frfr_info_id);
      if (!fireId) {
        continue;
      }

      const progressLabel = resolveProgressLabel(item);
      const progressStatus = resolveProgressStatus(progressLabel);
      const stepLabel = normalizeOptionalText(item.frfr_step_issu_cd);
      const baseLevel = isStepLevelEnabled(progressStatus) ? mapStepLevel(stepLabel) : EventLevels.Info;
      const uniqueKey = buildUniqueKey(fireId, progressStatus, stepLabel);

      const occurredAt = resolveOccurredAt(item);
      if (isTooOld(occurredAt, nowMs)) {
        continue;
      }

      const lastHighLevel = getLastHighLevel(highLevelSent, fireId, nowMs);
      const shouldBoost = baseLevel !== EventLevels.Info && (lastHighLevel === null || baseLevel > lastHighLevel);
      const level = shouldBoost ? baseLevel : EventLevels.Info;

      if (shouldEmitEvent(seen.get(uniqueKey), nowMs)) {
        events.push(buildEvent(item, occurredAt, progressLabel, progressStatus, stepLabel, level));
      }

      if (baseLevel !== EventLevels.Info) {
        const nextLevel = lastHighLevel === null ? baseLevel : pickHigherLevel(lastHighLevel, baseLevel);
        highLevelSent.set(fireId, { level: nextLevel, seenAt: nowIso });
      }

      seen.set(uniqueKey, nowIso);
    }

    pruneTimedMap(seen, nowMs);
    pruneHighLevelMap(highLevelSent, nowMs);
    const nextState = buildState(seen, highLevelSent);

    return { events, nextState };
  }
}

const buildEvent = (
  item: ForestFireItem,
  occurredAt: string | null,
  progressLabel: string | null,
  progressStatus: ProgressStatus,
  stepLabel: string | null,
  level: EventLevels,
): SourceEvent => {
  const regionText = normalizeOptionalText(item.frfr_sttmn_addr);
  const title = buildTitle(regionText, progressLabel, stepLabel);

  return {
    kind: EventKinds.Wildfire,
    title,
    body: buildBody(item, regionText, progressLabel, stepLabel),
    occurredAt,
    regionText,
    level,
    payload: buildPayload(item, progressLabel, progressStatus, stepLabel),
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

  const fireAt = normalizeOptionalText(item.frfr_frng_dtm);
  if (fireAt) {
    lines.push(`발생 시각: ${fireAt}`);
  }

  const endAt = normalizeOptionalText(item.potfr_end_dtm);
  if (endAt) {
    lines.push(`진화 시각: ${endAt}`);
  }

  return lines.length > 0 ? lines.join('\n') : null;
};

const buildPayload = (
  item: ForestFireItem,
  progressLabel: string | null,
  progressStatus: ProgressStatus,
  stepLabel: string | null,
): EventPayload => {
  return {
    fireInfoId: normalizeOptionalText(item.frfr_info_id),
    progressCode: normalizeOptionalText(item.frfr_prgrs_stcd),
    progressLabel,
    progressStatus,
    stepLabel,
    statementDate: normalizeOptionalText(item.frfr_sttmn_dt),
    fireAt: normalizeOptionalText(item.frfr_frng_dtm),
    endAt: normalizeOptionalText(item.potfr_end_dtm),
    address: normalizeOptionalText(item.frfr_sttmn_addr),
    coordX: parseCoordinate(item.frfr_lctn_xcrd),
    coordY: parseCoordinate(item.frfr_lctn_ycrd),
  };
};

const buildUniqueKey = (fireId: string, progressStatus: ProgressStatus, stepLabel: string | null): string => {
  const progressKey = progressStatus;
  const stepKey = stepLabel ?? 'unknown';

  return `${fireId}|${progressKey}|${stepKey}`;
};

const resolveOccurredAt = (item: ForestFireItem): string | null => {
  const occurredAt = parseKstDateTime(item.frfr_frng_dtm);
  if (occurredAt) {
    return occurredAt;
  }

  return parseKstDate(item.frfr_sttmn_dt);
};

const resolveProgressLabel = (item: ForestFireItem): string | null => {
  return normalizeOptionalText(item.frfr_prgrs_stcd_str) ?? normalizeOptionalText(item.frfr_prgrs_stcd);
};

const resolveProgressStatus = (progressLabel: string | null): ProgressStatus => {
  const normalized = normalizeOptionalText(progressLabel);
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
  const normalized = normalizeOptionalText(stepLabel);
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

const normalizeOptionalText = (value: string | null | undefined): string | null => {
  if (!value) {
    return null;
  }

  const trimmed = value.trim();
  if (!trimmed || trimmed === '-') {
    return null;
  }

  return trimmed;
};

const parseKstDateTime = (value: string | null | undefined): string | null => {
  const normalized = normalizeOptionalText(value);
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
  const normalized = normalizeOptionalText(value);
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

const shouldEmitEvent = (lastSeen: string | undefined, nowMs: number): boolean => {
  if (!lastSeen) {
    return true;
  }

  const parsed = Date.parse(lastSeen);
  if (!Number.isFinite(parsed)) {
    return true;
  }

  return nowMs - parsed > STATE_TTL_MS;
};

const isTooOld = (occurredAt: string | null, nowMs: number): boolean => {
  if (!occurredAt) {
    return false;
  }

  const parsed = Date.parse(occurredAt);
  if (!Number.isFinite(parsed)) {
    return false;
  }

  return nowMs - parsed > EVENT_MAX_AGE_MS;
};

const pruneTimedMap = (items: Map<string, string>, nowMs: number): void => {
  for (const [key, value] of items) {
    const parsed = Date.parse(value);
    if (!Number.isFinite(parsed) || nowMs - parsed > STATE_TTL_MS) {
      items.delete(key);
    }
  }
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

const parseJsonResponse = async (response: Response, sourceId: EventSources): Promise<unknown | null> => {
  try {
    const text = await response.text();
    return JSON.parse(text) as unknown;
  } catch (error) {
    logger.warn({ error, sourceId }, 'Failed to decode forest fire info response');
    return null;
  }
};

const fetchWithTimeout = async (url: string, init: RequestInit): Promise<Response | null> => {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  try {
    const response = await fetch(url, { ...init, signal: controller.signal });
    if (!response.ok) {
      logger.warn({ status: response.status }, 'Forest fire info request failed');
      return null;
    }

    return response;
  } catch (error) {
    logger.warn(error, 'Forest fire info request error');
    return null;
  } finally {
    clearTimeout(timeout);
  }
};
