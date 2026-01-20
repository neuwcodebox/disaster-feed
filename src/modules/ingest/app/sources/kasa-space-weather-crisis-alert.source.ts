import { load } from 'cheerio';
import { Agent, fetch, Headers, type Response } from 'undici';
import { z } from 'zod';
import { logger } from '@/core/logger';
import type { EventPayload } from '@/modules/events/domain/entity/event.entity';
import { EventKinds, EventLevels, EventSources } from '@/modules/events/domain/event.enums';
import type { Source, SourceEvent, SourceRunResult } from '../../domain/port/source.interface';
import { isTooOld } from './_shared/is-too-old';
import { normalizeText } from './_shared/normalize';
import { pruneTimedMap } from './_shared/prune-timed-map';
import { resolveDateOnlyWithServerTime } from './_shared/resolve-date-only-with-server-time';
import { shouldEmitEvent } from './_shared/should-emit-event';

const KASA_SPACE_WEATHER_CRISIS_ENDPOINT = 'https://spaceweather.kasa.go.kr/Alarm.do';
const TABLE_SELECTOR = '#content table';
const REQUEST_TIMEOUT_MS = 15000;
const INSECURE_DISPATCHER = new Agent({ connect: { rejectUnauthorized: false } });
const STATE_TTL_MS = 1000 * 60 * 60 * 24 * 3;
const EVENT_MAX_AGE_MS = STATE_TTL_MS * 0.9;
const REQUIRED_KEYWORDS = ['우주전파재난', '위기경보 발령'];
const EXCLUDED_KEYWORDS = ['모의', '훈련'];

const schemaSpaceWeatherCrisisRow = z.object({
  id: z.string().min(1),
  title: z.string().min(1),
  issuedAt: z.string().min(1),
});

type SpaceWeatherCrisisRow = z.infer<typeof schemaSpaceWeatherCrisisRow>;

type SpaceWeatherCrisisState = {
  seen: Record<string, string>;
};

export class KasaSpaceWeatherCrisisAlertSource implements Source {
  public readonly sourceId = EventSources.KasaSpaceWeatherCrisisAlert;
  public readonly pollIntervalSec = 60 * 5;

  public async run(state: string | null): Promise<SourceRunResult> {
    const isFirstRun = !state;
    const previousState = parseState(state);
    const seen = new Map<string, string>(Object.entries(previousState.seen));
    const now = new Date();
    const nowMs = now.getTime();
    const nowIso = now.toISOString();

    const response = await fetchWithTimeout({
      url: KASA_SPACE_WEATHER_CRISIS_ENDPOINT,
      init: { method: 'POST' },
      timeoutMs: REQUEST_TIMEOUT_MS,
    });
    if (!response) {
      throw new Error('KASA space weather crisis alert request failed');
    }

    const html = await response.text();
    const rows = parseRows(html);

    const events: SourceEvent[] = [];
    for (const row of rows) {
      if (!isTargetTitle(row.title)) {
        continue;
      }

      const occurredAt = parseIssuedAt(row.issuedAt, now);
      if (isTooOld(occurredAt, nowMs, EVENT_MAX_AGE_MS)) {
        continue;
      }

      if (!isFirstRun && shouldEmitEvent(seen.get(row.id), nowMs, STATE_TTL_MS)) {
        events.push(buildEvent(row, occurredAt));
      }
      seen.set(row.id, nowIso);
    }

    pruneTimedMap(seen, nowMs, STATE_TTL_MS);
    const nextState = buildState(seen);

    return { events, nextState };
  }
}

function buildEvent(row: SpaceWeatherCrisisRow, occurredAt: string | null): SourceEvent {
  return {
    kind: EventKinds.SpaceWeather,
    title: row.title,
    body: null,
    occurredAt,
    regionText: null,
    level: mapAlertLevel(row.title),
    payload: buildPayload(row, occurredAt),
  };
}

function buildPayload(row: SpaceWeatherCrisisRow, occurredAt: string | null): EventPayload {
  return {
    alarmId: row.id,
    issuedAt: row.issuedAt,
    issuedAtIso: occurredAt,
  };
}

function mapAlertLevel(title: string): EventLevels {
  const normalized = normalizeText(title);
  if (!normalized) {
    return EventLevels.Info;
  }

  if (normalized.includes('해제')) {
    return EventLevels.Info;
  }
  if (normalized.includes('심각')) {
    return EventLevels.Severe;
  }
  if (normalized.includes('경계')) {
    return EventLevels.Moderate;
  }
  if (normalized.includes('주의')) {
    return EventLevels.Minor;
  }
  if (normalized.includes('관심')) {
    return EventLevels.Info;
  }

  return EventLevels.Info;
}

function isTargetTitle(value: string): boolean {
  const normalized = normalizeText(value);
  if (!normalized) {
    return false;
  }

  for (const keyword of REQUIRED_KEYWORDS) {
    if (!normalized.includes(keyword)) {
      return false;
    }
  }

  for (const keyword of EXCLUDED_KEYWORDS) {
    if (normalized.includes(keyword)) {
      return false;
    }
  }

  return true;
}

function parseRows(html: string): SpaceWeatherCrisisRow[] {
  const $ = load(html);
  const table = $(TABLE_SELECTOR).first();
  if (table.length === 0) {
    logger.warn('Failed to find KASA space weather crisis alert table');
    throw new Error('Failed to find KASA space weather crisis alert table');
  }

  const rows: SpaceWeatherCrisisRow[] = [];
  const elements = table.find('tr').toArray();

  for (const element of elements) {
    const cells = $(element).find('td').toArray();
    if (cells.length < 4) {
      continue;
    }

    const titleCell = $(cells[1]);
    const titleAnchor = titleCell.find('a').first();
    const title = normalizeText(titleAnchor.text()) ?? normalizeText(titleCell.text()) ?? '';
    const onclick = titleAnchor.attr('onclick');
    const issuedAt = normalizeText($(cells[3]).text()) ?? '';
    const id = extractDetailId(onclick) ?? '';

    const parsed = schemaSpaceWeatherCrisisRow.safeParse({ id, title, issuedAt });
    if (!parsed.success) {
      logger.warn({ error: parsed.error }, 'Failed to parse KASA space weather crisis alert row');
      continue;
    }

    rows.push(parsed.data);
  }

  return rows;
}

function extractDetailId(value: string | undefined): string | null {
  if (!value) {
    return null;
  }

  const matched = value.match(/fnDetail\(['"]([^'"]+)['"]\)/);
  if (!matched || !matched[1]) {
    return null;
  }

  const normalized = matched[1].trim();
  return normalized.length > 0 ? normalized : null;
}

function parseState(state: string | null): SpaceWeatherCrisisState {
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
    logger.warn({ error }, 'Failed to parse KASA space weather crisis alert checkpoint state');
    return { seen: {} };
  }
}

function buildState(seen: Map<string, string>): string | null {
  if (seen.size === 0) {
    return null;
  }

  const payload: Record<string, string> = {};
  for (const [key, value] of seen) {
    payload[key] = value;
  }

  return JSON.stringify({ seen: payload });
}

function parseIssuedAt(value: string, now: Date): string | null {
  const normalized = normalizeText(value);
  if (!normalized) {
    return null;
  }

  const matched = normalized.match(/^(\d{4})[./-](\d{2})[./-](\d{2})$/);
  if (!matched) {
    return null;
  }

  const [, year, month, day] = matched;
  const yearNum = Number(year);
  const monthNum = Number(month);
  const dayNum = Number(day);
  if (!Number.isFinite(yearNum) || !Number.isFinite(monthNum) || !Number.isFinite(dayNum)) {
    return null;
  }

  return resolveDateOnlyWithServerTime({ year: yearNum, month: monthNum, day: dayNum }, now);
}

type FetchInit = NonNullable<Parameters<typeof fetch>[1]>;

type FetchWithTimeoutOptions = {
  url: string;
  init?: FetchInit;
  timeoutMs?: number;
};

async function fetchWithTimeout(options: FetchWithTimeoutOptions): Promise<Response | null> {
  const controller = new AbortController();
  const timeoutMs = options.timeoutMs ?? 10000;
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  const initWithSignal: FetchInit = {
    ...(options.init ?? {}),
    signal: controller.signal,
    dispatcher: INSECURE_DISPATCHER,
  };

  const headers = new Headers(initWithSignal.headers);
  if (!headers.has('User-Agent')) {
    headers.set('User-Agent', 'Mozilla/5.0');
  }
  initWithSignal.headers = headers;

  try {
    const response = await fetch(options.url, initWithSignal);
    if (!response.ok) {
      logger.warn({ status: response.status, url: options.url }, 'KASA space weather crisis alert request failed');
      return null;
    }

    return response;
  } catch (error) {
    logger.warn(error, 'KASA space weather crisis alert request error');
    return null;
  } finally {
    clearTimeout(timeout);
  }
}
