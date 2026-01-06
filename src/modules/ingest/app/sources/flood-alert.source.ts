import { z } from 'zod';
import { logger } from '@/core/logger';
import type { EventGeo } from '@/modules/events/domain/entity/event.entity';
import { EventKinds, EventLevels, EventSources } from '@/modules/events/domain/event.enums';
import type { Source, SourceEvent, SourceRunResult } from '../../domain/port/source.interface';
import { fetchWithTimeout } from './_shared/fetch-with-timeout';
import { isTooOld } from './_shared/is-too-old';
import { normalizeText } from './_shared/normalize';
import { pruneTimedMap } from './_shared/prune-timed-map';

const FLOOD_BASE_TIME_ENDPOINT = 'https://m.flood.go.kr/cmmn/lsttm.do';
const FLOOD_OBS_LIST_ENDPOINT = 'https://m.flood.go.kr/data/getFloodObsList.do';
const REQUEST_TIMEOUT_MS = 15000;
const STATE_TTL_MS = 1000 * 60 * 60 * 24;
const EVENT_MAX_AGE_MS = STATE_TTL_MS * 0.9;

const FCT_KIND_STAT_NAME = [
  '주의보 발령',
  '경보 발령',
  '주의보 변경 발령',
  '경보 변경 발령',
  '주의보 해제',
  '경보 해제',
] as const;
const FCT_KIND_CLASS_NAME = ['lev3', 'lev4', 'lev3', 'lev4', 'lev0', 'lev0'] as const;

const schemaFloodObsItem = z
  .object({
    wlobscd: z.string().optional().nullable(),
    obsnm: z.string().optional().nullable(),
    addr: z.string().optional().nullable(),
    rvnm: z.string().optional().nullable(),
    rvgd: z.string().optional().nullable(),
    fcodvcd: z.string().optional().nullable(),
    ymdhm: z.string().optional().nullable(),
    wrnwl: z.string().optional().nullable(),
    almwl: z.string().optional().nullable(),
    wl: z.string().optional().nullable(),
    b10: z.string().optional().nullable(),
    id: z.string().optional().nullable(),
    kind: z.string().optional().nullable(),
    choDiv: z.string().optional().nullable(),
    lat: z.string().optional().nullable(),
    lon: z.string().optional().nullable(),
    ancdt: z.string().optional().nullable(),
    startNum: z.string().optional().nullable(),
    endNum: z.string().optional().nullable(),
    totalCount: z.string().optional().nullable(),
    bbsncd: z.string().optional().nullable(),
    bbsnnm: z.string().optional().nullable(),
    sdcd: z.string().optional().nullable(),
    sdnm: z.string().optional().nullable(),
  })
  .loose();

const schemaFloodObsListResponse = z.array(schemaFloodObsItem);

type FloodObsItem = z.infer<typeof schemaFloodObsItem>;

type FloodAlertState = {
  seen: Record<string, string>;
};

type FloodKindInfo = {
  label: string | null;
  level: EventLevels;
  levelClass: string | null;
};

export class FloodAlertSource implements Source {
  public readonly sourceId = EventSources.FloodAlert;
  public readonly pollIntervalSec = 60 * 5;

  public async run(state: string | null): Promise<SourceRunResult> {
    const baseTime = await fetchBaseTime();
    const items = await fetchFloodObsList(baseTime);

    const previousState = parseState(state);
    const seen = new Map<string, string>(Object.entries(previousState.seen));
    const now = new Date();
    const nowMs = now.getTime();
    const nowIso = now.toISOString();

    const events: SourceEvent[] = [];
    for (const item of items) {
      const alertId = normalizeText(item.id);
      if (!alertId) {
        continue;
      }

      const occurredAt = parseKstCompactTimestamp(item.ancdt);
      if (!occurredAt) {
        continue;
      }

      if (isTooOld(occurredAt, nowMs, EVENT_MAX_AGE_MS)) {
        continue;
      }

      if (seen.has(alertId)) {
        continue;
      }

      const kindInfo = resolveKindInfo(item.kind);
      events.push(buildEvent(item, occurredAt, kindInfo));
      seen.set(alertId, nowIso);
    }

    pruneTimedMap(seen, nowMs, STATE_TTL_MS);
    const nextState = buildState(seen);

    return { events, nextState };
  }
}

async function fetchBaseTime(): Promise<string> {
  const response = await fetchWithTimeout({
    url: FLOOD_BASE_TIME_ENDPOINT,
    init: {
      method: 'POST',
    },
    timeoutMs: REQUEST_TIMEOUT_MS,
  });

  if (!response) {
    throw new Error('Flood base time request failed');
  }

  const rawText = await response.text();
  const trimmed = rawText.trim();
  if (!/^\d{12}$/.test(trimmed)) {
    logger.warn({ response: rawText }, 'Invalid flood base time response');
    throw new Error('Invalid flood base time response');
  }

  return trimmed;
}

async function fetchFloodObsList(baseTime: string): Promise<FloodObsItem[]> {
  const url = new URL(FLOOD_OBS_LIST_ENDPOINT);
  url.search = new URLSearchParams({
    obsnm: '',
    fcodvcd: 'ALL',
    bbsncd: 'ALL',
    sdnm: '',
    ymdhm: baseTime,
    choDiv: '2',
  }).toString();

  const response = await fetchWithTimeout({
    url: url.toString(),
    init: {
      method: 'POST',
      headers: {
        Accept: 'application/json',
      },
    },
    timeoutMs: REQUEST_TIMEOUT_MS,
  });

  if (!response) {
    throw new Error('Flood observation list request failed');
  }

  const rawText = await response.text();
  let data: unknown;
  try {
    data = JSON.parse(rawText);
  } catch (error) {
    logger.warn({ error, sample: rawText.slice(0, 200) }, 'Failed to parse flood observation response');
    throw new Error('Failed to parse flood observation response');
  }

  const parsed = schemaFloodObsListResponse.safeParse(data);
  if (!parsed.success) {
    logger.warn({ error: parsed.error }, 'Failed to validate flood observation response');
    throw new Error('Failed to validate flood observation response');
  }

  return parsed.data;
}

function resolveKindInfo(rawKind: string | null | undefined): FloodKindInfo {
  const normalized = normalizeText(rawKind);
  if (!normalized) {
    return { label: null, level: EventLevels.Info, levelClass: null };
  }

  const index = Number.parseInt(normalized, 10);
  if (!Number.isFinite(index)) {
    return { label: null, level: EventLevels.Info, levelClass: null };
  }

  const label = FCT_KIND_STAT_NAME[index] ?? null;
  const levelClass = FCT_KIND_CLASS_NAME[index] ?? null;

  return {
    label,
    level: mapLevelClass(levelClass),
    levelClass,
  };
}

function mapLevelClass(value: string | null): EventLevels {
  if (value === 'lev4') {
    return EventLevels.Severe;
  }
  if (value === 'lev3') {
    return EventLevels.Moderate;
  }
  return EventLevels.Info;
}

function buildEvent(item: FloodObsItem, occurredAt: string, kindInfo: FloodKindInfo): SourceEvent {
  const stationName = normalizeText(item.obsnm);
  const riverName = normalizeText(item.rvnm);
  const address = normalizeText(item.addr);

  return {
    kind: EventKinds.Flood,
    title: buildTitle(stationName, riverName, kindInfo.label),
    body: buildBody(item),
    occurredAt,
    regionText: buildRegionText(stationName, address),
    geo: buildGeo(item.lat, item.lon),
    level: kindInfo.level,
    payload: item,
  };
}

function buildTitle(stationName: string | null, riverName: string | null, kindLabel: string | null): string {
  const parts = [stationName, riverName, '홍수', kindLabel].filter((value): value is string =>
    Boolean(normalizeText(value)),
  );

  if (parts.length > 0) {
    return parts.join(' ');
  }

  return '홍수 특보';
}

function buildBody(item: FloodObsItem): string | null {
  const lines: string[] = [];

  const waterLevel = normalizeText(item.wl);
  const warnLevel = normalizeText(item.wrnwl);
  const alertLevel = normalizeText(item.almwl);
  const levelParts: string[] = [];
  if (waterLevel) {
    levelParts.push(`현재 ${waterLevel}m`);
  }
  if (warnLevel) {
    levelParts.push(`주의보 ${warnLevel}m`);
  }
  if (alertLevel) {
    levelParts.push(`경보 ${alertLevel}m`);
  }
  if (levelParts.length > 0 && waterLevel) {
    lines.push(`수위: ${levelParts.join(', ')}`);
  }

  return lines.length > 0 ? lines.join('\n') : null;
}

function buildRegionText(stationName: string | null, address: string | null): string | null {
  if (address) {
    return address;
  }

  return stationName;
}

function buildGeo(lat: string | null | undefined, lon: string | null | undefined): EventGeo | null {
  const latitude = parseCoordinate(lat);
  const longitude = parseCoordinate(lon);

  if (latitude === null || longitude === null) {
    return null;
  }

  return { lat: latitude, lng: longitude };
}

function parseCoordinate(value: string | null | undefined): number | null {
  const normalized = normalizeText(value);
  if (!normalized) {
    return null;
  }

  const parsed = Number(normalized);
  return Number.isFinite(parsed) ? parsed : null;
}

function parseKstCompactTimestamp(value: string | null | undefined): string | null {
  const normalized = normalizeText(value);
  if (!normalized) {
    return null;
  }

  const matched = normalized.match(/^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})$/);
  if (!matched) {
    return null;
  }

  const [, year, month, day, hour, minute] = matched;
  const utcMs = Date.UTC(Number(year), Number(month) - 1, Number(day), Number(hour) - 9, Number(minute), 0);
  const date = new Date(utcMs);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function parseState(state: string | null): FloodAlertState {
  if (!state) {
    return { seen: {} };
  }

  try {
    const parsed = JSON.parse(state) as { seen?: unknown };
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return { seen: {} };
    }

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
    logger.warn({ error }, 'Failed to parse flood alert checkpoint state');
    return { seen: {} };
  }
}

function buildState(seen: Map<string, string>): string | null {
  if (seen.size === 0) {
    return null;
  }

  return JSON.stringify({ seen: Object.fromEntries(seen) });
}
