import { load } from 'cheerio';
import { z } from 'zod';
import { logger } from '@/core/logger';
import type { EventPayload } from '@/modules/events/domain/entity/event.entity';
import { EventKinds, EventLevels, EventSources } from '@/modules/events/domain/event.enums';
import type { Source, SourceEvent, SourceRunResult } from '../../domain/port/source.interface';

const AIRKOREA_O3_WARNING_ENDPOINT = 'https://www.airkorea.or.kr/web/o3WarningSubTab1?lastymd=today';
const REQUEST_TIMEOUT_MS = 15000;
const STATE_TTL_MS = 1000 * 60 * 60 * 24;
const EVENT_MAX_AGE_MS = STATE_TTL_MS * 0.9;

const schemaO3WarningRow = z.object({
  region: z.string().min(1),
  area: z.string().nullable(),
  level: z.string().min(1),
  issuedAt: z.string().min(1),
  clearedAt: z.string().nullable(),
});

type O3WarningRow = z.infer<typeof schemaO3WarningRow>;

type O3WarningGroup = {
  region: string;
  level: string;
  issuedAtRaw: string;
  issuedAt: string | null;
  zones: string[];
};

type O3WarningState = {
  seen: Record<string, string>;
};

export class AirkoreaO3WarningSource implements Source {
  public readonly sourceId = EventSources.AirkoreaO3Warning;
  public readonly pollIntervalSec = 60 * 5;

  public async run(state: string | null): Promise<SourceRunResult> {
    const response = await fetchWithTimeout();
    if (!response) {
      return { events: [], nextState: state };
    }

    const html = await response.text();
    const rows = parseWarningRows(html);
    if (rows.length === 0) {
      return { events: [], nextState: state };
    }

    const groups = groupWarningRows(rows);
    const previousState = parseState(state);
    const seen = new Map<string, string>(Object.entries(previousState.seen));
    const now = new Date();
    const nowIso = now.toISOString();
    const nowMs = now.getTime();

    const events: SourceEvent[] = [];
    for (const group of groups) {
      if (isTooOld(group.issuedAt, nowMs)) {
        continue;
      }

      const key = buildGroupKey(group.region, group.level, group.issuedAtRaw);
      if (!seen.has(key)) {
        events.push(buildWarningEvent(group));
      }
      seen.set(key, nowIso);
    }

    pruneSeen(seen, nowMs);
    const nextState = buildState(seen);

    return { events, nextState };
  }
}

const buildWarningEvent = (group: O3WarningGroup): SourceEvent => {
  return {
    kind: EventKinds.O3,
    title: buildTitle(group.region, group.level),
    body: buildBody(group.zones),
    occurredAt: group.issuedAt,
    regionText: normalizeOptionalText(group.region),
    level: mapWarningLevel(group.level),
    payload: buildPayload(group),
  };
};

const buildTitle = (region: string, level: string): string => {
  const parts = [normalizeOptionalText(region), '오존', normalizeOptionalText(level) || '안내'];
  return parts.join(' ').trim();
};

const buildBody = (zones: string[]): string | null => {
  if (zones.length === 0) {
    return null;
  }

  return `권역: ${zones.join(', ')}`;
};

const buildPayload = (group: O3WarningGroup): EventPayload => {
  return {
    region: group.region,
    level: group.level,
    issuedAt: group.issuedAtRaw,
    issuedAtIso: group.issuedAt,
    zones: group.zones,
  };
};

const mapWarningLevel = (value: string): EventLevels => {
  const normalized = normalizeText(value);
  if (normalized.includes('경보')) {
    return EventLevels.Severe;
  }
  if (normalized.includes('주의')) {
    return EventLevels.Moderate;
  }
  return EventLevels.Info;
};

const parseWarningRows = (html: string): O3WarningRow[] => {
  const $ = load(html);
  const table = $('table').first();
  if (table.length === 0) {
    logger.warn('Failed to find AirKorea O3 warning table');
    return [];
  }

  const rows: O3WarningRow[] = [];
  const elements = table.find('tbody tr').toArray();
  if (elements.length === 0) {
    const text = normalizeText(table.find('tbody').text());
    if (text.includes('없')) {
      return [];
    }
  }

  for (const element of elements) {
    const cells = $(element).find('td').toArray();
    if (cells.length < 6) {
      const text = normalizeText($(element).text());
      if (text.includes('자료') || text.includes('없')) {
        continue;
      }
      continue;
    }

    const values = cells.map((cell) => normalizeText($(cell).text()));
    const row = {
      region: values[1] ?? '',
      area: normalizeOptionalText(values[2]),
      level: values[3] ?? '',
      issuedAt: values[4] ?? '',
      clearedAt: normalizeOptionalText(values[5]),
    };

    const parsed = schemaO3WarningRow.safeParse(row);
    if (!parsed.success) {
      logger.warn({ error: parsed.error }, 'Failed to parse AirKorea O3 warning row');
      continue;
    }

    rows.push(parsed.data);
  }

  return rows;
};

const groupWarningRows = (rows: O3WarningRow[]): O3WarningGroup[] => {
  const groups = new Map<string, O3WarningGroup>();

  for (const row of rows) {
    const key = buildGroupKey(row.region, row.level, row.issuedAt);
    let group = groups.get(key);
    if (!group) {
      group = {
        region: row.region,
        level: row.level,
        issuedAtRaw: row.issuedAt,
        issuedAt: parseKstHourTimestamp(row.issuedAt),
        zones: [],
      };
      groups.set(key, group);
    }

    const area = normalizeOptionalText(row.area);
    if (area && !group.zones.includes(area)) {
      group.zones.push(area);
    }
  }

  return [...groups.values()];
};

const buildGroupKey = (region: string, level: string, issuedAt: string): string => {
  return [normalizeKeyPart(region), normalizeKeyPart(level), normalizeKeyPart(issuedAt)].join('|');
};

const normalizeKeyPart = (value: string): string => {
  return normalizeText(value).toUpperCase();
};

const parseState = (state: string | null): O3WarningState => {
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
    logger.warn({ error }, 'Failed to parse AirKorea O3 warning checkpoint state');
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

const pruneSeen = (seen: Map<string, string>, nowMs: number): void => {
  for (const [key, value] of seen) {
    const parsed = Date.parse(value);
    if (!Number.isFinite(parsed) || nowMs - parsed > STATE_TTL_MS) {
      seen.delete(key);
    }
  }
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

const normalizeText = (value: string): string => {
  return value.replace(/\s+/g, ' ').trim();
};

const normalizeOptionalText = (value: string | null | undefined): string | null => {
  if (!value) {
    return null;
  }
  const normalized = normalizeText(value);
  return normalized.length > 0 ? normalized : null;
};

const parseKstHourTimestamp = (value: string): string | null => {
  const normalized = normalizeOptionalText(value);
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
  const date = new Date(utcMs);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
};

const fetchWithTimeout = async (): Promise<Response | null> => {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  try {
    const response = await fetch(AIRKOREA_O3_WARNING_ENDPOINT, { method: 'POST', signal: controller.signal });
    if (!response.ok) {
      logger.warn({ status: response.status }, 'AirKorea O3 warning request failed');
      return null;
    }

    return response;
  } catch (error) {
    logger.warn(error, 'AirKorea O3 warning request error');
    return null;
  } finally {
    clearTimeout(timeout);
  }
};
