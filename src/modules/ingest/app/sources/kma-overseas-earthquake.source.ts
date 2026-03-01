import { load } from 'cheerio';
import type { AnyNode } from 'domhandler';
import { env } from '@/core/env';
import { logger } from '@/core/logger';
import { EventKinds, EventLevels, EventSources } from '@/modules/events/domain/event.enums';
import type { Source, SourceEvent, SourceRunResult } from '../../domain/port/source.interface';
import { fetchWithTimeout } from './_shared/fetch-with-timeout';
import { isTooOld } from './_shared/is-too-old';
import { normalizeText } from './_shared/normalize';
import { pruneTimedMap } from './_shared/prune-timed-map';

const KMA_OVERSEAS_EARTHQUAKE_ENDPOINT = 'https://apihub.kma.go.kr/api/typ09/url/eqk/urlNewNotiEqk.do';
const REQUEST_TIMEOUT_MS = 15000;
const STATE_TTL_MS = 1000 * 60 * 60 * 24 * 3;
const EVENT_MAX_AGE_MS = STATE_TTL_MS * 0.9;
const KST_OFFSET_MS = 9 * 60 * 60 * 1000;

const INTENSITY_BY_LABEL: Record<string, number> = {
  Ⅰ: 1,
  I: 1,
  '1': 1,
  Ⅱ: 2,
  II: 2,
  '2': 2,
  Ⅲ: 3,
  III: 3,
  '3': 3,
  Ⅳ: 4,
  IV: 4,
  '4': 4,
  Ⅴ: 5,
  V: 5,
  '5': 5,
  Ⅵ: 6,
  VI: 6,
  '6': 6,
  Ⅶ: 7,
  VII: 7,
  '7': 7,
  Ⅷ: 8,
  VIII: 8,
  '8': 8,
  Ⅸ: 9,
  IX: 9,
  '9': 9,
  Ⅹ: 10,
  X: 10,
  '10': 10,
  Ⅺ: 11,
  XI: 11,
  '11': 11,
  Ⅻ: 12,
  XII: 12,
  '12': 12,
};

type OverseasEarthquakeItem = {
  msgCode: string | null;
  cntDiv: string | null;
  arDiv: string | null;
  eqArCdNm: string | null;
  eqPt: string | null;
  nkDiv: string | null;
  tmIssueRaw: string | null;
  eqDateRaw: string | null;
  magnitude: number | null;
  magnitudeDiff: string | null;
  depthKm: number | null;
  latitude: number | null;
  longitude: number | null;
  majorAxis: string | null;
  minorAxis: string | null;
  depthDiff: string | null;
  maxIntensity: string | null;
  intensityAreas: string | null;
  refer: string | null;
};

type OverseasEarthquakeState = {
  seen: Record<string, string>;
};

export class KmaOverseasEarthquakeSource implements Source {
  public readonly sourceId = EventSources.KmaOverseasEarthquake;
  public readonly pollIntervalSec = 60;

  public async run(state: string | null): Promise<SourceRunResult> {
    const isInitialRun = state === null;
    const authKey = env.KMA_API_KEY;
    if (!authKey) {
      logger.error('KMA overseas earthquake auth key is missing');
      throw new Error('KMA overseas earthquake auth key is missing');
    }

    const now = new Date();
    const { frDate, laDate } = resolveKstDateRange(now);

    const response = await fetchWithTimeout({
      url: buildRequestUrl(authKey, frDate, laDate),
      timeoutMs: REQUEST_TIMEOUT_MS,
    });
    if (!response) {
      throw new Error('KMA overseas earthquake request failed');
    }

    const xml = await response.text();
    const items = parseOverseasEarthquakeItems(xml);

    const previousState = parseState(state);
    const seen = new Map<string, string>(Object.entries(previousState.seen));
    const nowIso = now.toISOString();
    const nowMs = now.getTime();

    const events: SourceEvent[] = [];
    for (const item of items) {
      if (!hasDomesticImpact(item)) {
        continue;
      }

      const occurredAt = parseKstCompactTimestamp(item.eqDateRaw);
      if (isTooOld(occurredAt, nowMs, EVENT_MAX_AGE_MS)) {
        continue;
      }

      const eventId = buildEventId(item.eqDateRaw, item.tmIssueRaw);
      if (!eventId) {
        logger.warn({ eqDate: item.eqDateRaw, tmIssue: item.tmIssueRaw }, 'Missing KMA overseas event id');
        continue;
      }

      if (seen.has(eventId)) {
        seen.set(eventId, nowIso);
        continue;
      }

      if (isInitialRun) {
        seen.set(eventId, nowIso);
        continue;
      }

      events.push(buildEarthquakeEvent(item, occurredAt));
      seen.set(eventId, nowIso);
    }

    pruneTimedMap(seen, nowMs, STATE_TTL_MS);
    const nextState = buildState(seen);

    return { events: isInitialRun ? [] : events, nextState };
  }
}

function hasDomesticImpact(item: OverseasEarthquakeItem): boolean {
  return Boolean(item.maxIntensity && item.intensityAreas);
}

function buildEarthquakeEvent(item: OverseasEarthquakeItem, occurredAt: string | null): SourceEvent {
  const location = resolveLocation(item);
  const title = buildTitle(location, item.magnitude);
  const body = buildBody(item);
  const geo = resolveGeo(item);

  return {
    kind: EventKinds.Quake,
    title,
    body,
    occurredAt,
    regionText: location,
    geo,
    level: mapIntensityToLevel(item.maxIntensity),
    payload: item,
  };
}

function buildTitle(location: string | null, magnitude: number | null): string {
  const parts: string[] = [];

  if (location) {
    parts.push(location);
  }

  if (magnitude !== null) {
    parts.push(`규모 ${formatMagnitude(magnitude)}`);
  }

  if (parts.length === 0) {
    return '국외지진';
  }

  return `${parts.join(' ')} 지진`;
}

function buildBody(item: OverseasEarthquakeItem): string | null {
  const lines: string[] = [];

  if (item.maxIntensity) {
    lines.push(`국내 최대진도: ${item.maxIntensity}`);
  }

  if (item.intensityAreas) {
    lines.push(`지역별 진도: ${item.intensityAreas}`);
  }

  if (item.depthKm !== null) {
    lines.push(`깊이: ${formatDepth(item.depthKm)}`);
  }

  if (item.refer) {
    lines.push(`참고: ${item.refer}`);
  }

  const issuedAt = formatKstCompactTimestamp(item.tmIssueRaw);
  if (issuedAt) {
    lines.push(`발표 시각: ${issuedAt}`);
  }

  return lines.length > 0 ? lines.join('\n') : null;
}

function mapIntensityToLevel(value: string | null): EventLevels {
  const intensity = parseIntensityValue(value);
  if (intensity === null) {
    return EventLevels.Info;
  }

  if (intensity >= 7) {
    return EventLevels.Severe;
  }
  if (intensity >= 5) {
    return EventLevels.Moderate;
  }
  if (intensity >= 4) {
    return EventLevels.Minor;
  }

  return EventLevels.Info;
}

function parseOverseasEarthquakeItems(xml: string): OverseasEarthquakeItem[] {
  const $ = load(xml, { xmlMode: true });
  const nodes = $('info').toArray();
  if (nodes.length === 0) {
    logger.warn('Failed to find KMA overseas earthquake info nodes');
  }

  const items: OverseasEarthquakeItem[] = [];
  for (const node of nodes) {
    const cntDiv = normalizeText(extractText($, node, 'cntDiv'));
    if (cntDiv && cntDiv !== 'N') {
      continue;
    }

    const eqDateRaw = extractText($, node, 'eqDate');
    const tmIssueRaw = extractText($, node, 'tmIssue');

    items.push({
      msgCode: normalizeText(extractText($, node, 'msgCode')),
      cntDiv,
      arDiv: normalizeText(extractText($, node, 'arDiv')),
      eqArCdNm: normalizeText(extractText($, node, 'eqArCdNm')),
      eqPt: normalizeText(extractText($, node, 'eqPt')),
      nkDiv: normalizeText(extractText($, node, 'nkDiv')),
      tmIssueRaw,
      eqDateRaw,
      magnitude: parseNumber(extractText($, node, 'magMl')),
      magnitudeDiff: normalizeText(extractText($, node, 'magDiff')),
      depthKm: parseNumber(extractText($, node, 'eqDt')),
      latitude: parseNumber(extractText($, node, 'eqLt')),
      longitude: parseNumber(extractText($, node, 'eqLn')),
      majorAxis: normalizeText(extractText($, node, 'majorAxis')),
      minorAxis: normalizeText(extractText($, node, 'minorAxis')),
      depthDiff: normalizeText(extractText($, node, 'depthDiff')),
      maxIntensity: normalizeText(extractText($, node, 'jdLoc')),
      intensityAreas: normalizeText(extractText($, node, 'jdLocA')),
      refer: normalizeText(extractText($, node, 'ReFer')),
    });
  }

  return items;
}

function extractText($: ReturnType<typeof load>, node: AnyNode, tag: string): string | null {
  const text = $(node).find(tag).first().text();
  const trimmed = text.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function parseNumber(value: string | null): number | null {
  if (!value) {
    return null;
  }

  const parsed = Number.parseFloat(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function resolveLocation(item: OverseasEarthquakeItem): string | null {
  return item.eqPt ?? item.eqArCdNm ?? null;
}

function resolveGeo(item: OverseasEarthquakeItem): { lat: number; lng: number } | null {
  if (item.latitude === null || item.longitude === null) {
    return null;
  }

  return { lat: item.latitude, lng: item.longitude };
}

function parseIntensityValue(value: string | null): number | null {
  const normalized = normalizeText(value);
  if (!normalized) {
    return null;
  }

  const compact = normalized.replace(/\s+/g, '').toUpperCase();
  const direct = INTENSITY_BY_LABEL[compact];
  if (direct !== undefined) {
    return direct;
  }

  for (const [label, level] of Object.entries(INTENSITY_BY_LABEL)) {
    if (compact.includes(label)) {
      return level;
    }
  }

  const numeric = compact.match(/\d+/);
  if (!numeric) {
    return null;
  }

  const parsed = Number.parseInt(numeric[0], 10);
  return Number.isFinite(parsed) ? parsed : null;
}

function formatMagnitude(value: number): string {
  return value.toFixed(1);
}

function formatDepth(value: number): string {
  if (value <= 0) {
    return '-';
  }

  return `${value.toFixed(1)} km`;
}

function buildEventId(eqDateRaw: string | null, tmIssueRaw: string | null): string | null {
  const occurred = normalizeCompactTimestamp(eqDateRaw);
  const issued = normalizeCompactTimestamp(tmIssueRaw);
  if (!occurred || !issued) {
    return null;
  }

  return `${occurred}:${issued}`;
}

function normalizeCompactTimestamp(value: string | null): string | null {
  if (!value) {
    return null;
  }

  const digits = value.replace(/\D/g, '');
  if (digits.length < 12) {
    return null;
  }

  return digits;
}

function parseKstCompactTimestamp(value: string | null): string | null {
  const normalized = normalizeCompactTimestamp(value);
  if (!normalized) {
    return null;
  }

  if (normalized.length !== 12 && normalized.length !== 14) {
    return null;
  }

  const year = normalized.slice(0, 4);
  const month = normalized.slice(4, 6);
  const day = normalized.slice(6, 8);
  const hour = normalized.slice(8, 10);
  const minute = normalized.slice(10, 12);
  const second = normalized.length === 14 ? normalized.slice(12, 14) : '00';

  const utcMs = Date.UTC(
    Number(year),
    Number(month) - 1,
    Number(day),
    Number(hour) - 9,
    Number(minute),
    Number(second),
  );
  const date = new Date(utcMs);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function formatKstCompactTimestamp(value: string | null): string | null {
  const normalized = normalizeCompactTimestamp(value);
  if (!normalized) {
    return null;
  }

  if (normalized.length !== 12 && normalized.length !== 14) {
    return normalizeText(value);
  }

  const year = normalized.slice(0, 4);
  const month = normalized.slice(4, 6);
  const day = normalized.slice(6, 8);
  const hour = normalized.slice(8, 10);
  const minute = normalized.slice(10, 12);
  const second = normalized.length === 14 ? normalized.slice(12, 14) : null;

  if (!second) {
    return `${year}-${month}-${day} ${hour}:${minute} KST`;
  }

  return `${year}-${month}-${day} ${hour}:${minute}:${second} KST`;
}

function resolveKstDateRange(now: Date): { frDate: string; laDate: string } {
  const kstNow = new Date(now.getTime() + KST_OFFSET_MS);
  const today = formatKstDateLabel(kstNow);
  const yesterday = formatKstDateLabel(new Date(kstNow.getTime() - 24 * 60 * 60 * 1000));
  return { frDate: yesterday, laDate: today };
}

function formatKstDateLabel(date: Date): string {
  const year = date.getUTCFullYear();
  const month = String(date.getUTCMonth() + 1).padStart(2, '0');
  const day = String(date.getUTCDate()).padStart(2, '0');
  return `${year}${month}${day}`;
}

function buildRequestUrl(authKey: string, frDate: string, laDate: string): string {
  const url = new URL(KMA_OVERSEAS_EARTHQUAKE_ENDPOINT);
  url.search = new URLSearchParams({
    orderTy: 'xml',
    frDate,
    laDate,
    cntDiv: 'N',
    authKey,
  }).toString();
  return url.toString();
}

function parseState(state: string | null): OverseasEarthquakeState {
  if (!state) {
    return { seen: {} };
  }

  try {
    const parsed = JSON.parse(state) as { seen?: unknown };
    if (!parsed.seen || typeof parsed.seen !== 'object' || Array.isArray(parsed.seen)) {
      return { seen: {} };
    }

    const seen: Record<string, string> = {};
    for (const [key, value] of Object.entries(parsed.seen as Record<string, unknown>)) {
      if (typeof value === 'string') {
        seen[key] = value;
      }
    }

    return { seen };
  } catch (error) {
    logger.warn({ error }, 'Failed to parse KMA overseas checkpoint state');
    return { seen: {} };
  }
}

function buildState(seen: Map<string, string>): string | null {
  return JSON.stringify({ seen: Object.fromEntries(seen) });
}
