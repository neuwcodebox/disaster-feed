import { load } from 'cheerio';
import { z } from 'zod';
import { logger } from '@/core/logger';
import type { EventPayload } from '@/modules/events/domain/entity/event.entity';
import { EventKinds, EventLevels, EventSources } from '@/modules/events/domain/event.enums';
import type { Source, SourceEvent, SourceRunResult } from '../../domain/port/source.interface';
import { fetchWithTimeout } from './_shared/fetch-with-timeout';
import { isTooOld } from './_shared/is-too-old';
import { normalizeText } from './_shared/normalize';
import { pruneTimedMap } from './_shared/prune-timed-map';
import { shouldEmitEvent } from './_shared/should-emit-event';

const NCSC_CYBER_CRISIS_ENDPOINT =
  'https://www.ncsc.go.kr/cop/bbs/selectBoardList.do?bbsId=CyberCrisis_main&nttId=0&bbsTyCode=BBST01&bbsAttrbCode=BBSA15&authFlag&pageIndex=1&searchBranchId';
const TABLE_SELECTOR = '#cnt0 > form > table';
const REQUEST_TIMEOUT_MS = 15000;
const STATE_TTL_MS = 1000 * 60 * 60 * 24 * 3;
const EVENT_MAX_AGE_MS = STATE_TTL_MS * 0.9;

const schemaCyberCrisisRow = z.object({
  id: z.string().min(1),
  title: z.string().min(1),
  level: z.string().min(1),
  issuedAt: z.string().min(1),
});

type CyberCrisisRow = z.infer<typeof schemaCyberCrisisRow>;

type CyberCrisisState = {
  seen: Record<string, string>;
};

export class NcscCyberCrisisSource implements Source {
  public readonly sourceId = EventSources.NcscCyberCrisis;
  public readonly pollIntervalSec = 60 * 10;

  public async run(state: string | null): Promise<SourceRunResult> {
    const previousState = parseState(state);
    const seen = new Map<string, string>(Object.entries(previousState.seen));
    const now = new Date();
    const nowMs = now.getTime();
    const nowIso = now.toISOString();

    const response = await fetchWithTimeout({
      url: NCSC_CYBER_CRISIS_ENDPOINT,
      init: { method: 'POST' },
      timeoutMs: REQUEST_TIMEOUT_MS,
    });
    if (!response) {
      throw new Error('NCSC cyber crisis request failed');
    }

    const html = await response.text();
    const rows = parseRows(html);

    const events: SourceEvent[] = [];
    for (const row of rows) {
      const occurredAt = parseKstDate(row.issuedAt);
      if (isTooOld(occurredAt, nowMs, EVENT_MAX_AGE_MS)) {
        continue;
      }
      if (shouldEmitEvent(seen.get(row.id), nowMs, STATE_TTL_MS)) {
        events.push(buildEvent(row, occurredAt));
      }
      seen.set(row.id, nowIso);
    }

    pruneTimedMap(seen, nowMs, STATE_TTL_MS);
    const nextState = buildState(seen);

    return { events, nextState };
  }
}

function buildEvent(row: CyberCrisisRow, occurredAt: string | null): SourceEvent {
  return {
    kind: EventKinds.Cyber,
    title: row.title,
    body: null,
    occurredAt,
    regionText: null,
    level: mapCrisisLevel(row.level),
    payload: buildPayload(row, occurredAt),
  };
}

function buildPayload(row: CyberCrisisRow, occurredAt: string | null): EventPayload {
  return {
    num: row.id,
    level: row.level,
    issuedAt: row.issuedAt,
    issuedAtIso: occurredAt,
  };
}

function mapCrisisLevel(value: string): EventLevels {
  const normalized = normalizeText(value);
  if (!normalized) {
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
  return EventLevels.Info;
}

function parseRows(html: string): CyberCrisisRow[] {
  const $ = load(html);
  const table = $(TABLE_SELECTOR).first();
  if (table.length === 0) {
    logger.warn('Failed to find NCSC cyber crisis table');
    throw new Error('Failed to find NCSC cyber crisis table');
  }

  const rows: CyberCrisisRow[] = [];
  const elements = table.find('tr').toArray();

  for (const element of elements) {
    const cells = $(element).find('td').toArray();
    if (cells.length < 4) {
      continue;
    }

    const values = cells.map((cell) => normalizeText($(cell).text()) ?? '');
    const row = {
      id: values[0] ?? '',
      title: values[1] ?? '',
      level: values[2] ?? '',
      issuedAt: values[3] ?? '',
    };

    const parsed = schemaCyberCrisisRow.safeParse(row);
    if (!parsed.success) {
      logger.warn({ error: parsed.error }, 'Failed to parse NCSC cyber crisis row');
      continue;
    }

    rows.push(parsed.data);
  }

  return rows;
}

function parseState(state: string | null): CyberCrisisState {
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
    logger.warn({ error }, 'Failed to parse NCSC cyber crisis checkpoint state');
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

function parseKstDate(value: string): string | null {
  const normalized = normalizeText(value);
  if (!normalized) {
    return null;
  }

  const matched = normalized.match(/^(\d{4})[./-](\d{2})[./-](\d{2})$/);
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
}
