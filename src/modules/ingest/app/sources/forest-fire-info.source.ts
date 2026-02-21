import { z } from 'zod';
import { logger } from '@/core/logger';
import { EventKinds, EventLevels, EventSources } from '@/modules/events/domain/event.enums';
import type { Source, SourceEvent, SourceRunResult } from '../../domain/port/source.interface';
import { fetchWithTimeout } from './_shared/fetch-with-timeout';
import { isTooOld } from './_shared/is-too-old';
import { normalizeText } from './_shared/normalize';

const FOREST_FIRE_INFO_ENDPOINT = 'https://fd.forest.go.kr/ffas/pubConn/selectPublicFireShowList.do';
const STATE_RANGE_DAYS = 7;
const STATE_TTL_MS = 1000 * 60 * 60 * 24 * STATE_RANGE_DAYS;
const EVENT_MAX_AGE_MS = STATE_TTL_MS * 0.9;

const schemaForestFireItem = z
  .object({
    frfrInfoId: z.string().nullish(),
    frfrPrgrsStcd: z.string().nullish(),
    frfrPrgrsStcdNm: z.string().nullish(),
    frfrStepIssuCd: z.string().nullish(),
    frfrStepIssuNm: z.string().nullish(),
    frfrSttmnAddr: z.string().nullish(),
    frfrSttmnAddrDe: z.string().nullish(),
    frfrFrngDtm: z.string().nullish(),
    potfrCmpleDtm: z.string().nullish(),
    frfrSttmnDt: z.string().nullish(),
    frfrSttmnHms: z.string().nullish(),
    frfrLctnXcrd: z.string().nullish(),
    frfrLctnYcrd: z.string().nullish(),
    frfrSttmnLctnXcrd: z.string().nullish(),
    frfrSttmnLctnYcrd: z.string().nullish(),
    lgdngCd: z.string().nullish(),
  })
  .loose();

const schemaForestFireResponse = z.object({
  fireShowInfoList: z.array(schemaForestFireItem).optional().default([]),
});

type ForestFireItem = z.infer<typeof schemaForestFireItem>;

const schemaForestFireStateStatus = z.enum(['in_progress', 'completed', 'unknown']);

const schemaForestFireStateSeenEntry = z.object({
  status: schemaForestFireStateStatus,
  step: z.string().nullable(),
  seenAt: z.string(),
});

const schemaForestFireState = z.object({
  seen: z.record(z.string(), schemaForestFireStateSeenEntry),
});

type ForestFireStateStatus = z.infer<typeof schemaForestFireStateStatus>;
type ForestFireSeenEntry = z.infer<typeof schemaForestFireStateSeenEntry>;

type ForestFireState = {
  seen: Record<string, ForestFireSeenEntry>;
};

type ProgressStatus = 'reported' | 'in_progress' | 'completed' | 'not_fire' | 'unknown';

const FOREST_FIRE_PROGRESS_LABELS_BY_CODE: Record<string, string> = {
  '02': '진화중',
  '03': '진화완료',
  '05': '산불외종료',
};

const FOREST_FIRE_STEP_LABELS_BY_CODE: Record<string, string> = {
  '00': '초기 대응',
  '01': '산불 1단계',
  '02': '산불 2단계',
  '03': '산불 3단계',
};

export class ForestFireInfoSource implements Source {
  public readonly sourceId = EventSources.ForestFireInfo;
  public readonly pollIntervalSec = 60 * 3;

  public async run(state: string | null): Promise<SourceRunResult> {
    const response = await fetchWithTimeout({
      url: FOREST_FIRE_INFO_ENDPOINT,
      init: {
        headers: {
          Accept: 'application/json',
        },
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
    const seen = new Map<string, ForestFireSeenEntry>(Object.entries(previousState?.seen ?? {}));
    const shouldEmitEvents = previousState !== null;
    const now = new Date();
    const nowMs = now.getTime();
    const nowIso = now.toISOString();

    const events: SourceEvent[] = [];

    for (const item of parsed.data.fireShowInfoList) {
      const fireId = normalizeText(item.frfrInfoId);
      if (!fireId) {
        continue;
      }

      const progressLabel = resolveProgressLabel(item);
      const progressStatus = resolveProgressStatus(progressLabel);
      const stateStatus = mapStateStatus(progressStatus);
      const stepLabel = resolveStepLabel(item);
      const baseLevel = isStepLevelEnabled(stateStatus) ? mapStepLevel(stepLabel) : EventLevels.Info;

      const resolvedOccurredAt = resolveOccurredAt(item);
      const resolvedCompletedAt = resolveCompletedAt(item);
      const previousEntry = seen.get(fireId);
      const occurredAt = resolveEventOccurredAt(
        stateStatus,
        previousEntry,
        resolvedOccurredAt,
        resolvedCompletedAt,
        nowIso,
      );
      if (isTooOld(occurredAt, nowMs, EVENT_MAX_AGE_MS)) {
        continue;
      }

      if (shouldEmitEvents && shouldEmitTransition(previousEntry, stateStatus, stepLabel)) {
        events.push(buildEvent(item, occurredAt, progressLabel, stepLabel, baseLevel));
      }

      seen.set(fireId, { status: stateStatus, step: stepLabel, seenAt: nowIso });
    }

    pruneSeenMap(seen, nowMs, STATE_TTL_MS);
    const nextState = buildState(seen);

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
  const regionText = resolveRegionText(item);
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

  const fireAt = normalizeText(item.frfrFrngDtm);
  if (fireAt) {
    lines.push(`발생 시각: ${fireAt}`);
  }

  const endAt = normalizeText(item.potfrCmpleDtm);
  if (endAt) {
    lines.push(`진화 시각: ${endAt}`);
  }

  return lines.length > 0 ? lines.join('\n') : null;
};

const resolveOccurredAt = (item: ForestFireItem): string | null => {
  const fireDateTime = parseKstDateTime(item.frfrFrngDtm);
  if (fireDateTime) {
    return fireDateTime;
  }

  return parseCompactKstDateTime(item.frfrSttmnDt, item.frfrSttmnHms);
};

const resolveCompletedAt = (item: ForestFireItem): string | null => {
  return parseKstDateTime(item.potfrCmpleDtm);
};

const resolveEventOccurredAt = (
  status: ForestFireStateStatus,
  previousEntry: ForestFireSeenEntry | undefined,
  occurredAt: string | null,
  completedAt: string | null,
  nowIso: string,
): string => {
  if (status === 'completed') {
    return completedAt ?? nowIso;
  }

  if (status === 'in_progress') {
    if (!previousEntry) {
      return occurredAt ?? nowIso;
    }

    return nowIso;
  }

  return nowIso;
};

const resolveProgressLabel = (item: ForestFireItem): string | null => {
  const progressName = normalizeText(item.frfrPrgrsStcdNm);
  if (progressName) {
    return progressName;
  }

  const progressCode = normalizeText(item.frfrPrgrsStcd);
  if (!progressCode) {
    return null;
  }

  return FOREST_FIRE_PROGRESS_LABELS_BY_CODE[progressCode] ?? progressCode;
};

const resolveStepLabel = (item: ForestFireItem): string | null => {
  const stepName = normalizeText(item.frfrStepIssuNm);
  if (stepName) {
    return stepName;
  }

  const stepCode = normalizeText(item.frfrStepIssuCd);
  if (!stepCode) {
    return null;
  }

  return FOREST_FIRE_STEP_LABELS_BY_CODE[stepCode] ?? stepCode;
};

const resolveRegionText = (item: ForestFireItem): string | null => {
  return normalizeText(item.frfrSttmnAddrDe) ?? normalizeText(item.frfrSttmnAddr);
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

const mapStateStatus = (progressStatus: ProgressStatus): ForestFireStateStatus => {
  if (progressStatus === 'reported' || progressStatus === 'in_progress') {
    return 'in_progress';
  }
  if (progressStatus === 'completed' || progressStatus === 'not_fire') {
    return 'completed';
  }

  return 'unknown';
};

const shouldEmitTransition = (
  previousEntry: ForestFireSeenEntry | undefined,
  status: ForestFireStateStatus,
  step: string | null,
): boolean => {
  if (!previousEntry) {
    return true;
  }

  return previousEntry.status !== status || previousEntry.step !== step;
};

const isStepLevelEnabled = (status: ForestFireStateStatus): boolean => {
  return status === 'in_progress';
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

  const parts = trimmed.split(/\s+/);
  const [first, second] = parts;
  if (!first) {
    return regionText;
  }

  if (!second) {
    return first;
  }

  return `${first} ${second}`;
};

const parseCoordinate = (value: string | null | undefined): number | null => {
  if (!value) {
    return null;
  }

  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
};

const resolveGeo = (item: ForestFireItem): { lat: number; lng: number } | null => {
  const lng = parseCoordinate(item.frfrLctnXcrd) ?? parseCoordinate(item.frfrSttmnLctnXcrd);
  const lat = parseCoordinate(item.frfrLctnYcrd) ?? parseCoordinate(item.frfrSttmnLctnYcrd);

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

const parseCompactKstDateTime = (
  dateValue: string | null | undefined,
  timeValue: string | null | undefined,
): string | null => {
  const date = normalizeText(dateValue);
  const time = normalizeText(timeValue);
  if (!date || !time) {
    return null;
  }

  const matchedDate = date.match(/^(\d{4})(\d{2})(\d{2})$/);
  const matchedTime = time.match(/^(\d{2})(\d{2})(\d{2})$/);
  if (!matchedDate || !matchedTime) {
    return null;
  }

  const [, year, month, day] = matchedDate;
  const [, hour, minute, second] = matchedTime;
  const kstIso = `${year}-${month}-${day}T${hour}:${minute}:${second}+09:00`;
  const parsed = new Date(kstIso);
  if (Number.isNaN(parsed.getTime())) {
    return null;
  }

  return parsed.toISOString();
};

const pruneSeenMap = (items: Map<string, ForestFireSeenEntry>, nowMs: number, ttlMs: number): void => {
  for (const [key, value] of items) {
    const parsed = Date.parse(value.seenAt);
    if (!Number.isFinite(parsed) || nowMs - parsed > ttlMs) {
      items.delete(key);
    }
  }
};

const parseState = (state: string | null): ForestFireState | null => {
  if (!state) {
    return null;
  }

  try {
    const parsed = schemaForestFireState.safeParse(JSON.parse(state));
    if (!parsed.success) {
      logger.warn({ error: parsed.error }, 'Failed to parse forest fire info checkpoint state');
      return null;
    }

    return parsed.data;
  } catch (error) {
    logger.warn({ error }, 'Failed to parse forest fire info checkpoint state');
    return null;
  }
};

const buildState = (seen: Map<string, ForestFireSeenEntry>): string => {
  const seenPayload: Record<string, ForestFireSeenEntry> = {};
  for (const [key, value] of seen) {
    seenPayload[key] = {
      status: value.status,
      step: value.step,
      seenAt: value.seenAt,
    };
  }

  return JSON.stringify({ seen: seenPayload });
};
