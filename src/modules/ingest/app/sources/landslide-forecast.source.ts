import { type Cheerio, type CheerioAPI, load } from 'cheerio';
import type { AnyNode } from 'domhandler';
import { z } from 'zod';
import { logger } from '@/core/logger';
import { EventKinds, EventLevels, EventSources } from '@/modules/events/domain/event.enums';
import type { Source, SourceEvent, SourceRunResult } from '../../domain/port/source.interface';
import { fetchWithTimeout } from './_shared/fetch-with-timeout';
import { isTooOld } from './_shared/is-too-old';
import { normalizeText } from './_shared/normalize';
import { pruneTimedMap } from './_shared/prune-timed-map';
import { shouldEmitEvent } from './_shared/should-emit-event';

const LANDSLIDE_FORECAST_ENDPOINT = 'https://sansatai.forest.go.kr/forecast/alertList.do';
const TABLE_SELECTOR = '#fctTbl';
const REQUEST_TIMEOUT_MS = 15000;
const STATE_TTL_MS = 1000 * 60 * 60 * 4;
const EVENT_MAX_AGE_MS = STATE_TTL_MS * 0.9;

const schemaLandslideRow = z.object({
  alertId: z.string().min(1),
  regionText: z.string().nullable(),
  regionCode: z.string().nullable(),
  alertType: z.string().min(1),
  forecastAt: z.string().nullable(),
  issuedAt: z.string().nullable(),
  closedAt: z.string().nullable(),
  status: z.string().min(1),
});

const schemaLandslideState = z.object({
  seen: z.record(z.string(), z.string()),
});

type LandslideRow = z.infer<typeof schemaLandslideRow>;

type LandslideState = {
  seen: Record<string, string>;
};

export class LandslideForecastSource implements Source {
  public readonly sourceId = EventSources.LandslideForecast;
  public readonly pollIntervalSec = 60 * 10;

  public async run(state: string | null): Promise<SourceRunResult> {
    const previousState = parseState(state);
    const seen = new Map<string, string>(Object.entries(previousState.seen));
    const now = new Date();
    const nowMs = now.getTime();
    const nowIso = now.toISOString();

    const response = await fetchWithTimeout({
      url: LANDSLIDE_FORECAST_ENDPOINT,
      timeoutMs: REQUEST_TIMEOUT_MS,
    });
    if (!response) {
      throw new Error('Landslide forecast request failed');
    }

    const html = await response.text();
    const rows = parseRows(html);

    const events: SourceEvent[] = [];
    for (const row of rows) {
      const occurredAt = resolveOccurredAt(now, row.forecastAt, row.issuedAt);
      if (!isIssuedStatus(row.status) || isTooOld(occurredAt, nowMs, EVENT_MAX_AGE_MS)) {
        continue;
      }

      if (shouldEmitEvent(seen.get(row.alertId), nowMs, STATE_TTL_MS)) {
        events.push(buildEvent(row, occurredAt));
      }

      seen.set(row.alertId, nowIso);
    }

    pruneTimedMap(seen, nowMs, STATE_TTL_MS);
    const nextState = buildState(seen);

    return { events, nextState };
  }
}

function buildEvent(row: LandslideRow, occurredAt: string): SourceEvent {
  return {
    kind: EventKinds.Landslide,
    title: buildTitle(row.regionText, row.alertType),
    body: null,
    occurredAt,
    regionText: row.regionText,
    regionCodes: row.regionCode ? [row.regionCode] : null,
    level: mapAlertLevel(row.alertType),
    payload: row,
  };
}

function buildTitle(regionText: string | null, alertType: string): string {
  const prefix = regionText ? `${regionText} ` : '';
  return `${prefix}산사태 ${alertType} 발령`.trim();
}

function mapAlertLevel(alertType: string): EventLevels {
  const normalized = normalizeText(alertType);
  if (!normalized) {
    return EventLevels.Info;
  }

  if (normalized.includes('경보')) {
    return EventLevels.Moderate;
  }
  if (normalized.includes('주의보')) {
    return EventLevels.Minor;
  }

  return EventLevels.Info;
}

function isIssuedStatus(status: string): boolean {
  const normalized = normalizeText(status);
  return normalized === '발령';
}

function parseRows(html: string): LandslideRow[] {
  const $ = load(html);
  const table = $(TABLE_SELECTOR).first();
  if (table.length === 0) {
    logger.warn('Failed to find landslide forecast table');
    throw new Error('Failed to find landslide forecast table');
  }

  const bodyRows = table.find('tbody tr').toArray();
  const elements = bodyRows.length > 0 ? bodyRows : table.find('tr').toArray();
  const rows: LandslideRow[] = [];

  for (const element of elements) {
    const cells = $(element).find('td').toArray();
    if (cells.length < 7) {
      continue;
    }

    const meta = resolveMoveAlertViewInfo($, $(element));
    const row = {
      alertId: meta.alertId ?? '',
      regionText: resolveRegionText($(cells[0])),
      regionCode: meta.regionCode,
      alertType: resolveCellText($(cells[1])) ?? '',
      forecastAt: resolveCellTime($(cells[2])),
      issuedAt: resolveCellTime($(cells[3])),
      closedAt: resolveCellTime($(cells[4])),
      status: resolveCellText($(cells[6])) ?? '',
    };

    const parsed = schemaLandslideRow.safeParse(row);
    if (!parsed.success) {
      logger.warn({ error: parsed.error, row }, 'Failed to parse landslide forecast row');
      continue;
    }

    rows.push(parsed.data);
  }

  return rows;
}

function resolveMoveAlertViewInfo(
  $: CheerioAPI,
  row: Cheerio<AnyNode>,
): { regionCode: string | null; alertId: string | null } {
  const anchors = row.find('a').toArray();
  for (const anchor of anchors) {
    const href = $(anchor).attr('href');
    const parsed = parseMoveAlertViewArgs(href);
    if (parsed) {
      return parsed;
    }
  }

  const fallbackAlertId = normalizeText(row.find('input.staId').attr('value'));
  return { regionCode: null, alertId: fallbackAlertId };
}

function parseMoveAlertViewArgs(
  value: string | null | undefined,
): { regionCode: string | null; alertId: string | null } | null {
  if (!value) {
    return null;
  }

  const matched = value.match(/fn_moveAlertView\(\s*['"]([^'"]*)['"]\s*,\s*['"][^'"]*['"]\s*,\s*['"]([^'"]*)['"]\s*\)/);
  if (!matched) {
    return null;
  }

  const [, regionCodeRaw, alertIdRaw] = matched;
  return {
    regionCode: normalizeRegionCode(regionCodeRaw),
    alertId: normalizeText(alertIdRaw),
  };
}

function resolveRegionText(cell: Cheerio<AnyNode>): string | null {
  const linkText = normalizeText(cell.find('a').first().text());
  if (linkText) {
    return linkText;
  }

  return normalizeText(cell.text());
}

function resolveCellText(cell: Cheerio<AnyNode>): string | null {
  return normalizeText(cell.text());
}

function resolveCellTime(cell: Cheerio<AnyNode>): string | null {
  const title = normalizeText(cell.find('a').attr('title'));
  if (title) {
    return title;
  }

  return normalizeText(cell.text());
}

function normalizeRegionCode(value: string | null | undefined): string | null {
  const normalized = normalizeText(value);
  if (!normalized) {
    return null;
  }

  const digits = normalized.replace(/\D/g, '');
  if (!digits) {
    return null;
  }

  const padded = digits.padEnd(10, '0');
  return padded.length > 10 ? padded.slice(0, 10) : padded;
}

function resolveOccurredAt(now: Date, forecastAt: string | null, issuedAt: string | null): string {
  const candidates: Array<{ iso: string; ms: number }> = [{ iso: now.toISOString(), ms: now.getTime() }];

  const forecastIso = parseKstDateTime(forecastAt);
  if (forecastIso) {
    const ms = Date.parse(forecastIso);
    if (Number.isFinite(ms)) {
      candidates.push({ iso: forecastIso, ms });
    }
  }

  const issuedIso = parseKstDateTime(issuedAt);
  if (issuedIso) {
    const ms = Date.parse(issuedIso);
    if (Number.isFinite(ms)) {
      candidates.push({ iso: issuedIso, ms });
    }
  }

  let earliest = candidates[0];
  for (const candidate of candidates) {
    if (candidate.ms < earliest.ms) {
      earliest = candidate;
    }
  }

  return earliest.iso;
}

function parseKstDateTime(value: string | null | undefined): string | null {
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
}

function parseState(state: string | null): LandslideState {
  if (!state) {
    return { seen: {} };
  }

  try {
    const parsed = schemaLandslideState.safeParse(JSON.parse(state));
    if (!parsed.success) {
      logger.warn({ error: parsed.error }, 'Failed to parse landslide forecast checkpoint state');
      return { seen: {} };
    }

    return parsed.data;
  } catch (error) {
    logger.warn({ error }, 'Failed to parse landslide forecast checkpoint state');
    return { seen: {} };
  }
}

function buildState(seen: Map<string, string>): string {
  return JSON.stringify({ seen: Object.fromEntries(seen) });
}
