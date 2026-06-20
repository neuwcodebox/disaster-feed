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
import { resolveDateOnlyWithServerTime } from './_shared/resolve-date-only-with-server-time';
import { shouldEmitEvent } from './_shared/should-emit-event';

const NCSC_CYBER_CRISIS_ENDPOINT = 'https://www.ncsc.go.kr/api/usr/bbs/selectBbscttList';
const NCSC_CYBER_CRISIS_BBS_ID = 'BBS000313';
const PAGE_SIZE = 10;
const REQUEST_TIMEOUT_MS = 15000;
const STATE_TTL_MS = 1000 * 60 * 60 * 24 * 3;
const EVENT_MAX_AGE_MS = STATE_TTL_MS * 0.9;

const schemaNcscApiEnvelope = z.object({
  header: z.object({
    msgCode: z.string(),
    msg: z.string().optional(),
  }),
  data: z
    .array(
      z.object({
        list: z.array(z.unknown()),
      }),
    )
    .min(1),
});

const schemaCyberCrisisApiRow = z.object({
  bbscttId: z.string().min(1),
  bbsId: z.string().optional().nullable(),
  sj: z.string().min(1),
  scrtyLevel: z.string().min(1),
  gnfdDe: z.string().optional().nullable(),
  registDttm: z.string().optional().nullable(),
  cnHtml: z.string().optional().nullable(),
  rowIdx: z.string().optional().nullable(),
  updtDttm: z.string().optional().nullable(),
});

type CyberCrisisApiRow = z.infer<typeof schemaCyberCrisisApiRow>;

type CyberCrisisRow = {
  id: string;
  title: string;
  body: string | null;
  level: string;
  issuedAt: string;
  bbsId: string | null;
  rowIdx: string | null;
  updatedAt: string | null;
};

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

    const rows = await fetchRows();

    const events: SourceEvent[] = [];
    for (const row of rows) {
      const occurredAt = parseKstDate(row.issuedAt, now);
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

async function fetchRows(): Promise<CyberCrisisRow[]> {
  const response = await fetchWithTimeout({
    url: NCSC_CYBER_CRISIS_ENDPOINT,
    init: {
      method: 'POST',
      headers: buildJsonHeaders(),
      body: JSON.stringify({
        bbsId: NCSC_CYBER_CRISIS_BBS_ID,
        pageIndex: 1,
        pageSize: PAGE_SIZE,
      }),
    },
    timeoutMs: REQUEST_TIMEOUT_MS,
  });
  if (!response) {
    throw new Error('NCSC cyber crisis list request failed');
  }

  return parseRows(await response.json());
}

function buildJsonHeaders(): Record<string, string> {
  return {
    Accept: 'application/json',
    'Content-Type': 'application/json',
  };
}

function buildEvent(row: CyberCrisisRow, occurredAt: string | null): SourceEvent {
  return {
    kind: EventKinds.Cyber,
    title: row.title,
    body: row.body,
    occurredAt,
    regionText: null,
    level: mapCrisisLevel(row.level),
    payload: buildPayload(row, occurredAt),
  };
}

function buildPayload(row: CyberCrisisRow, occurredAt: string | null): EventPayload {
  return {
    bbscttId: row.id,
    bbsId: row.bbsId,
    rowIdx: row.rowIdx,
    level: row.level,
    issuedAt: row.issuedAt,
    issuedAtIso: occurredAt,
    updatedAt: row.updatedAt,
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

function parseRows(payload: unknown): CyberCrisisRow[] {
  const rowPayloads = parseEnvelopeList(payload);
  if (rowPayloads.length === 0) {
    logger.warn('Failed to find NCSC cyber crisis API rows');
  }

  const rows: CyberCrisisRow[] = [];
  for (const rowPayload of rowPayloads) {
    const parsed = schemaCyberCrisisApiRow.safeParse(rowPayload);
    if (!parsed.success) {
      logger.warn({ error: parsed.error }, 'Failed to parse NCSC cyber crisis row');
      continue;
    }

    const row = buildRow(parsed.data);
    if (!row) {
      continue;
    }

    rows.push(row);
  }

  return rows;
}

function parseEnvelopeList(payload: unknown): unknown[] {
  const parsedResponse = schemaNcscApiEnvelope.safeParse(payload);
  if (!parsedResponse.success) {
    logger.warn({ error: parsedResponse.error }, 'Failed to parse NCSC cyber crisis API response');
    throw new Error('Failed to parse NCSC cyber crisis API response');
  }

  if (parsedResponse.data.header.msgCode !== '1000') {
    logger.warn(
      { msgCode: parsedResponse.data.header.msgCode, msg: parsedResponse.data.header.msg },
      'NCSC cyber crisis API returned failure response',
    );
    throw new Error('NCSC cyber crisis API returned failure response');
  }

  const rows = parsedResponse.data.data[0]?.list ?? [];
  return rows;
}

function buildRow(row: CyberCrisisApiRow): CyberCrisisRow | null {
  const title = normalizeText(row.sj);
  const level = normalizeText(row.scrtyLevel);
  const issuedAt = normalizeText(row.gnfdDe) ?? normalizeText(row.registDttm);
  if (!title || !level || !issuedAt) {
    logger.warn({ bbscttId: row.bbscttId }, 'NCSC cyber crisis row is missing required values');
    return null;
  }

  return {
    id: row.bbscttId,
    title,
    body: htmlToText(row.cnHtml),
    level,
    issuedAt,
    bbsId: normalizeText(row.bbsId) ?? null,
    rowIdx: normalizeText(row.rowIdx) ?? null,
    updatedAt: normalizeText(row.updtDttm) ?? null,
  };
}

function htmlToText(value: string | null | undefined): string | null {
  const normalized = normalizeText(value);
  if (!normalized) {
    return null;
  }

  const html = normalized.replace(/<br\s*\/?>/gi, ' ').replace(/<\/(p|div|li|tr|td|th|h[1-6])>/gi, ' </$1>');
  const $ = load(html);
  return normalizeText($.root().text());
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

function buildState(seen: Map<string, string>): string {
  const payload: Record<string, string> = {};
  for (const [key, value] of seen) {
    payload[key] = value;
  }

  return JSON.stringify({ seen: payload });
}

function parseKstDate(value: string, now: Date): string | null {
  const normalized = normalizeText(value);
  if (!normalized) {
    return null;
  }

  const dateTimeMatched = normalized.match(/^(\d{4})[./-](\d{2})[./-](\d{2})(?:[ T](\d{2}):(\d{2})(?::(\d{2}))?)?$/);
  if (!dateTimeMatched) {
    return null;
  }

  const [, year, month, day, hour, minute, second] = dateTimeMatched;
  if (hour && minute) {
    const kstDate = new Date(`${year}-${month}-${day}T${hour}:${minute}:${second ?? '00'}+09:00`);
    if (Number.isNaN(kstDate.getTime())) {
      return null;
    }
    return kstDate.toISOString();
  }

  const yearNum = Number(year);
  const monthNum = Number(month);
  const dayNum = Number(day);
  return resolveDateOnlyWithServerTime({ year: yearNum, month: monthNum, day: dayNum }, now);
}
