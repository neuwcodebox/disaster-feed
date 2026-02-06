import { load } from 'cheerio';
import { z } from 'zod';
import { logger } from '@/core/logger';
import type { EventPayload } from '@/modules/events/domain/entity/event.entity';
import { EventKinds, EventLevels, EventSources } from '@/modules/events/domain/event.enums';
import type { IRegionRepository } from '../../domain/port/region-repo.interface';
import type { Source, SourceEvent, SourceRunResult } from '../../domain/port/source.interface';
import { fetchWithTimeout } from './_shared/fetch-with-timeout';
import { isTooOld } from './_shared/is-too-old';
import { normalizeText } from './_shared/normalize';
import { pruneTimedMap } from './_shared/prune-timed-map';
import { resolveRegionCodeByPrefix } from './_shared/resolve-region-code';

const AIRKOREA_PM_WARNING_ENDPOINT = 'https://www.airkorea.or.kr/web/pmWarning?pMENU_NO=115';
const MAX_PAGE = 3;
const STATE_TTL_MS = 1000 * 60 * 60 * 24;
const EVENT_MAX_AGE_MS = STATE_TTL_MS * 0.9;

const schemaPmWarningRow = z.object({
  region: z.string().min(1),
  area: z.string().nullable(),
  item: z.string().min(1),
  level: z.string().min(1),
  issuedAt: z.string().min(1),
  clearedAt: z.string().nullable(),
});

type PmWarningRow = z.infer<typeof schemaPmWarningRow>;

type PmWarningGroup = {
  region: string;
  item: string;
  level: string;
  issuedAtRaw: string;
  issuedAt: string | null;
  zones: string[];
};

type PmWarningState = {
  seen: Record<string, string>;
};

export class AirkoreaPmWarningSource implements Source {
  public readonly sourceId = EventSources.AirkoreaPmWarning;
  public readonly pollIntervalSec = 60 * 5;

  constructor(private readonly regionRepository: IRegionRepository) {}

  public async run(state: string | null): Promise<SourceRunResult> {
    const now = new Date();
    const nowIso = now.toISOString();
    const nowMs = now.getTime();
    const rows: PmWarningRow[] = [];
    const seenRowKeys = new Set<string>();
    let page = 1;

    while (page <= MAX_PAGE) {
      const response = await fetchWithTimeout({
        url: buildRequestUrl(page),
        init: { method: 'POST' },
        timeoutMs: 15000,
      });
      if (!response) {
        throw new Error(`AirKorea PM warning request failed: page ${page}`);
      }

      const html = await response.text();
      const pageRows = parseWarningRows(html);
      if (pageRows.length === 0) {
        break;
      }

      let hasOutdated = false;
      for (const row of pageRows) {
        if (!isRecentIssuedAt(row.issuedAt, nowMs)) {
          hasOutdated = true;
          break;
        }

        const rowKey = buildRowKey(row);
        if (seenRowKeys.has(rowKey)) {
          continue;
        }
        seenRowKeys.add(rowKey);
        rows.push(row);
      }

      if (hasOutdated) {
        break;
      }

      page += 1;
    }

    if (rows.length === 0) {
      return { events: [], nextState: state };
    }

    const groups = groupWarningRows(rows, nowMs);
    const previousState = parseState(state);
    const seen = new Map<string, string>(Object.entries(previousState.seen));
    const regionCodeCache = new Map<string, string | null>();

    const events: SourceEvent[] = [];
    for (const group of groups) {
      if (isTooOld(group.issuedAt, nowMs, EVENT_MAX_AGE_MS)) {
        continue;
      }

      const key = buildGroupKey(group.region, group.item, group.level, group.issuedAtRaw);
      if (!seen.has(key)) {
        const regionText = normalizeText(group.region);
        const regionCode = await resolveRegionCodeByPrefix(regionText, this.regionRepository, regionCodeCache);
        events.push(buildWarningEvent(group, regionText, regionCode));
      }
      seen.set(key, nowIso);
    }

    pruneTimedMap(seen, nowMs, STATE_TTL_MS);
    const nextState = buildState(seen);

    return { events, nextState };
  }
}

const buildWarningEvent = (
  group: PmWarningGroup,
  regionText: string | null,
  regionCode: string | null,
): SourceEvent => {
  return {
    kind: EventKinds.FineDust,
    title: buildTitle(group.region, group.item, group.level),
    body: buildBody(group.zones),
    occurredAt: group.issuedAt,
    regionText,
    regionCodes: regionCode ? [regionCode] : null,
    level: mapWarningLevel(group.level),
    payload: buildPayload(group),
  };
};

const buildTitle = (region: string, item: string, level: string): string => {
  const parts = [normalizeText(region), normalizeText(item), normalizeText(level)].filter((value): value is string =>
    Boolean(value),
  );
  return parts.length > 0 ? parts.join(' ') : '미세먼지 경보';
};

const buildBody = (zones: string[]): string | null => {
  if (zones.length === 0) {
    return null;
  }

  return `권역: ${zones.join(', ')}`;
};

const buildPayload = (group: PmWarningGroup): EventPayload => {
  return {
    region: group.region,
    item: group.item,
    level: group.level,
    issuedAt: group.issuedAtRaw,
    issuedAtIso: group.issuedAt,
    zones: group.zones,
  };
};

const mapWarningLevel = (value: string): EventLevels => {
  const normalized = normalizeText(value);
  if (normalized?.includes('중대')) {
    return EventLevels.Severe;
  }
  if (normalized?.includes('경보')) {
    return EventLevels.Moderate;
  }
  if (normalized?.includes('주의')) {
    return EventLevels.Minor;
  }
  return EventLevels.Info;
};

const parseWarningRows = (html: string): PmWarningRow[] => {
  const $ = load(html);
  const primaryTable = $('#dataSearch > div > div.contSub > div.tblList > table').first();
  const table = primaryTable.length > 0 ? primaryTable : $('#dataSearch .contSub .tblList table').first();
  if (table.length === 0) {
    logger.warn('Failed to find AirKorea PM warning table');
    throw new Error('Failed to find AirKorea PM warning table');
  }

  const rows: PmWarningRow[] = [];
  const elements = table.find('tbody tr').toArray();

  for (const element of elements) {
    const cells = $(element).find('td').toArray();
    if (cells.length < 7) {
      const text = normalizeText($(element).text()) ?? '';
      if (text.includes('자료') || text.includes('없')) {
        continue;
      }
      continue;
    }

    const values = cells.map((cell) => normalizeText($(cell).text()) ?? '');
    const row = {
      region: values[1] ?? '',
      area: normalizeText(values[2]),
      item: values[3] ?? '',
      level: values[4] ?? '',
      issuedAt: values[5] ?? '',
      clearedAt: normalizeText(values[6]),
    };

    const parsed = schemaPmWarningRow.safeParse(row);
    if (!parsed.success) {
      logger.warn({ error: parsed.error }, 'Failed to parse AirKorea PM warning row');
      continue;
    }

    rows.push(parsed.data);
  }

  return rows;
};

const groupWarningRows = (rows: PmWarningRow[], nowMs: number): PmWarningGroup[] => {
  const groups = new Map<string, PmWarningGroup>();

  for (const row of rows) {
    const key = buildGroupKey(row.region, row.item, row.level, row.issuedAt);
    let group = groups.get(key);
    if (!group) {
      group = {
        region: row.region,
        item: row.item,
        level: row.level,
        issuedAtRaw: row.issuedAt,
        issuedAt: parseKstHourTimestamp(row.issuedAt, nowMs),
        zones: [],
      };
      groups.set(key, group);
    }

    const area = normalizeText(row.area);
    if (area && !group.zones.includes(area)) {
      group.zones.push(area);
    }
  }

  return [...groups.values()];
};

const buildRowKey = (row: PmWarningRow): string => {
  return [
    normalizeText(row.region) ?? '',
    normalizeText(row.area ?? '') ?? '',
    normalizeText(row.item) ?? '',
    normalizeText(row.level) ?? '',
    normalizeText(row.issuedAt) ?? '',
  ].join('|');
};

const buildGroupKey = (region: string, item: string, level: string, issuedAt: string): string => {
  return [
    normalizeText(region) ?? '',
    normalizeText(item) ?? '',
    normalizeText(level) ?? '',
    normalizeText(issuedAt) ?? '',
  ].join('|');
};

const parseState = (state: string | null): PmWarningState => {
  if (!state) {
    return { seen: {} };
  }

  try {
    const parsed = JSON.parse(state) as { seen?: unknown };
    if (!parsed || typeof parsed !== 'object') {
      return { seen: {} };
    }

    const rawSeen = parsed.seen;
    if (!rawSeen || typeof rawSeen !== 'object' || Array.isArray(rawSeen)) {
      return { seen: {} };
    }

    const seen: Record<string, string> = {};
    for (const [key, value] of Object.entries(rawSeen as Record<string, unknown>)) {
      const trimmedKey = key.trim();
      if (trimmedKey && typeof value === 'string') {
        seen[trimmedKey] = value;
      }
    }

    return { seen };
  } catch (error) {
    logger.warn({ error }, 'Failed to parse AirKorea PM warning checkpoint state');
    return { seen: {} };
  }
};

const buildState = (seen: Map<string, string>): string | null => {
  if (seen.size === 0) {
    return null;
  }

  const payload: Record<string, string> = {};
  for (const [key, value] of seen) {
    payload[key] = value;
  }

  return JSON.stringify({ seen: payload });
};

const isRecentIssuedAt = (value: string, nowMs: number): boolean => {
  const issuedAt = parseKstHourTimestamp(value, nowMs);
  if (!issuedAt) {
    return true;
  }

  const parsed = Date.parse(issuedAt);
  if (!Number.isFinite(parsed)) {
    return true;
  }

  return nowMs - parsed <= STATE_TTL_MS;
};

const parseKstHourTimestamp = (value: string, nowMs: number): string | null => {
  const normalized = normalizeText(value);
  if (!normalized) {
    return null;
  }

  const matched = normalized.match(/^(\d{4})-(\d{2})-(\d{2})\s+(\d{1,2})(?::(\d{2}))?$/);
  if (!matched) {
    return null;
  }

  const [, yearText, monthText, dayText, hourText, minuteText] = matched;
  const hour = Number(hourText);
  const minute = minuteText ? Number(minuteText) : 0;

  if (!Number.isFinite(hour) || !Number.isFinite(minute)) {
    return null;
  }
  if (hour < 0 || hour > 24) {
    return null;
  }
  if (minute < 0 || minute >= 60) {
    return null;
  }
  if (hour === 24 && minute !== 0) {
    return null;
  }

  const utcMs = Date.UTC(Number(yearText), Number(monthText) - 1, Number(dayText), hour - 9, minute, 0);
  const parsedAt = new Date(utcMs);
  const parsedAtMs = parsedAt.getTime();
  if (Number.isNaN(parsedAtMs)) {
    return null;
  }

  const boundedAtMs = Math.min(parsedAtMs, nowMs);
  return new Date(boundedAtMs).toISOString();
};

const buildRequestUrl = (page: number): string => {
  const url = new URL(AIRKOREA_PM_WARNING_ENDPOINT);
  url.searchParams.set('page', String(page));
  return url.toString();
};
