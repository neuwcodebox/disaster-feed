import { z } from 'zod';
import { env } from '@/core/env';
import { logger } from '@/core/logger';
import type { EventPayload } from '@/modules/events/domain/entity/event.entity';
import { EventKinds, EventLevels, EventSources } from '@/modules/events/domain/event.enums';
import type { Source, SourceEvent, SourceRunResult } from '../../domain/port/source.interface';
import type { IStationRepository, StationInfo } from '../../domain/port/station-repo.interface';
import { fetchWithTimeout } from './_shared/fetch-with-timeout';
import { isTooOld } from './_shared/is-too-old';
import { normalizeText } from './_shared/normalize';

const KMA_AWS_ENDPOINT = 'https://apihub.kma.go.kr/api/typ01/cgi-bin/url/nph-aws2_min';
const REQUEST_TIMEOUT_MS = 30000;
const HYSTERESIS_RATIO = 0.5;
const DOWNGRADE_STABLE_WAIT_MS = 1000 * 60 * 60 * 24;
const EVENT_MAX_AGE_MS = 1000 * 60 * 60;

const TEMPERATURE_MIN_C = -40;
const TEMPERATURE_MAX_C = 50;
const WIND_SPEED_MAX_MS = 80;
const RAIN_60M_MAX_MM = 600;
const RAIN_ACCUM_MAX_MM = 5000;

const WIND_THRESHOLDS = [
  { level: EventLevels.Severe, avgMs: 30, gustMs: 45 },
  { level: EventLevels.Moderate, avgMs: 26, gustMs: 32 },
  { level: EventLevels.Minor, avgMs: 21, gustMs: 26 },
];

const RAIN_THRESHOLDS = [
  { level: EventLevels.Severe, intensity: 100, accum12h: 400 },
  { level: EventLevels.Moderate, intensity: 70, accum12h: 260 },
  { level: EventLevels.Minor, intensity: 50, accum12h: 180 },
];

const HEAT_THRESHOLDS = [
  { level: EventLevels.Severe, tempC: 41 },
  { level: EventLevels.Moderate, tempC: 39 },
  { level: EventLevels.Minor, tempC: 38 },
];

const COLD_THRESHOLDS = [
  { level: EventLevels.Severe, tempC: -26 },
  { level: EventLevels.Moderate, tempC: -21 },
  { level: EventLevels.Minor, tempC: -16 },
];

const EVENT_LEVEL_VALUES = Object.values(EventLevels).filter((value): value is number => typeof value === 'number');

type AwsRow = {
  timestamp: string;
  stationCode: number;
  wss: number | null;
  ws10: number | null;
  ta: number | null;
  rn60m: number | null;
  rn12h: number | null;
};

type AwsStateEntry = {
  level: EventLevels;
  lastAt: string;
};

type AwsState = {
  entries: Record<string, AwsStateEntry>;
};

type WindGustEvaluation = {
  level: EventLevels;
  speed: number;
};

type WindAvgEvaluation = {
  level: EventLevels;
  speed: number;
  basis: 'ws10';
};

type RainIntensityEvaluation = {
  level: EventLevels;
  intensity: number;
  basis: 'rn60m';
  rn60m: number | null;
};

type RainAccumEvaluation = {
  level: EventLevels;
  rn12h: number;
};

type TemperatureEvaluation = {
  level: EventLevels;
  kind: EventKinds;
  temperature: number;
};

type MetricKey = 'wind_gust' | 'wind_avg' | 'rain_intensity' | 'rain_accum' | 'heat' | 'cold';

const schemaAwsState: z.ZodType<AwsState> = z.object({
  entries: z.record(
    z.string(),
    z.object({
      level: z
        .number()
        .int()
        .refine((value) => EVENT_LEVEL_VALUES.includes(value), {
          message: 'Invalid event level',
        }),
      lastAt: z.string(),
    }),
  ),
});

export class KmaAwsObservationSource implements Source {
  public readonly sourceId = EventSources.KmaAwsObservation;
  public readonly pollIntervalSec = 60 * 3;

  constructor(private readonly stationRepository: IStationRepository) {}

  public async run(state: string | null): Promise<SourceRunResult> {
    const authKey = env.KMA_API_KEY;
    if (!authKey) {
      logger.error('KMA AWS auth key is missing');
      throw new Error('KMA AWS auth key is missing');
    }

    const response = await fetchWithTimeout({
      url: buildRequestUrl(authKey),
      timeoutMs: REQUEST_TIMEOUT_MS,
    });
    if (!response) {
      throw new Error('KMA AWS request failed');
    }

    const text = await response.text();
    const rows = parseAwsRows(text);

    const now = new Date();
    const nowIso = now.toISOString();
    const nowMs = now.getTime();

    const previousState = parseState(state);
    const stateMap = new Map<string, AwsStateEntry>(
      Object.entries(previousState.entries).filter(([, entry]) => entry.level !== EventLevels.Info),
    );
    const stationCache = new Map<number, StationInfo | null>();

    const events: SourceEvent[] = [];

    for (const row of rows) {
      const occurredAt = parseKstCompactTimestamp(row.timestamp);
      if (isTooOld(occurredAt, nowMs, EVENT_MAX_AGE_MS)) {
        continue;
      }

      const stationInfo = await resolveStationInfo(row.stationCode, this.stationRepository, stationCache);
      if (!stationInfo) {
        continue;
      }

      const windGust = evaluateWindGust(row);
      if (windGust) {
        await processLevel({
          metricKey: 'wind_gust',
          stationCode: row.stationCode,
          level: windGust.level,
          currentValue: windGust.speed,
          direction: 'higher',
          getThreshold: resolveWindGustThreshold,
          nowIso,
          stateMap,
          onEmit: async () => {
            events.push(buildWindEvent(row, windGust, 'gust', stationInfo, occurredAt));
          },
        });
      }

      const windAvg = evaluateWindAvg(row);
      if (windAvg) {
        await processLevel({
          metricKey: 'wind_avg',
          stationCode: row.stationCode,
          level: windAvg.level,
          currentValue: windAvg.speed,
          direction: 'higher',
          getThreshold: resolveWindAvgThreshold,
          nowIso,
          stateMap,
          onEmit: async () => {
            events.push(buildWindEvent(row, windAvg, 'avg_ws10', stationInfo, occurredAt));
          },
        });
      }

      const rainIntensity = evaluateRainIntensity(row);
      if (rainIntensity) {
        await processLevel({
          metricKey: 'rain_intensity',
          stationCode: row.stationCode,
          level: rainIntensity.level,
          currentValue: rainIntensity.intensity,
          direction: 'higher',
          getThreshold: resolveRainIntensityThreshold,
          nowIso,
          stateMap,
          onEmit: async () => {
            events.push(buildRainIntensityEvent(row, rainIntensity, stationInfo, occurredAt));
          },
        });
      }

      const rainAccum = evaluateRainAccum(row);
      if (rainAccum) {
        await processLevel({
          metricKey: 'rain_accum',
          stationCode: row.stationCode,
          level: rainAccum.level,
          currentValue: rainAccum.rn12h,
          direction: 'higher',
          getThreshold: resolveRainAccumThreshold,
          nowIso,
          stateMap,
          onEmit: async () => {
            events.push(buildRainAccumEvent(row, rainAccum, stationInfo, occurredAt));
          },
        });
      }

      if (row.ta !== null) {
        const heatEvaluation: TemperatureEvaluation = {
          level: resolveHeatLevel(row.ta),
          kind: EventKinds.Heat,
          temperature: row.ta,
        };
        await processLevel({
          metricKey: 'heat',
          stationCode: row.stationCode,
          level: heatEvaluation.level,
          currentValue: heatEvaluation.temperature,
          direction: 'higher',
          getThreshold: resolveHeatThreshold,
          nowIso,
          stateMap,
          onEmit: async () => {
            events.push(buildTemperatureEvent(row, heatEvaluation, stationInfo, occurredAt));
          },
        });

        const coldEvaluation: TemperatureEvaluation = {
          level: resolveColdLevel(row.ta),
          kind: EventKinds.Cold,
          temperature: row.ta,
        };
        await processLevel({
          metricKey: 'cold',
          stationCode: row.stationCode,
          level: coldEvaluation.level,
          currentValue: coldEvaluation.temperature,
          direction: 'lower',
          getThreshold: resolveColdThreshold,
          nowIso,
          stateMap,
          onEmit: async () => {
            events.push(buildTemperatureEvent(row, coldEvaluation, stationInfo, occurredAt));
          },
        });
      }
    }

    const nextState = buildState(stateMap);

    return { events, nextState };
  }
}

type ProcessLevelOptions = {
  metricKey: MetricKey;
  stationCode: number;
  level: EventLevels;
  currentValue: number;
  direction: 'higher' | 'lower';
  getThreshold: (level: EventLevels) => number | null;
  nowIso: string;
  stateMap: Map<string, AwsStateEntry>;
  onEmit: () => Promise<void>;
};

async function processLevel(options: ProcessLevelOptions): Promise<void> {
  const key = buildStateKey(options.metricKey, options.stationCode);
  const previous = options.stateMap.get(key);

  if (!previous || options.level > previous.level) {
    if (options.level > EventLevels.Info) {
      await options.onEmit();
    }
    updateStateEntry(options.stateMap, key, options.level, options.nowIso);
    return;
  }

  if (options.level === previous.level) {
    updateStateEntry(options.stateMap, key, previous.level, options.nowIso);
    return;
  }

  const previousThreshold = options.getThreshold(previous.level);
  if (previousThreshold === null) {
    updateStateEntry(options.stateMap, key, options.level, options.nowIso);
    return;
  }

  const hysteresisThreshold = previousThreshold * HYSTERESIS_RATIO;
  const shouldUpdate =
    options.direction === 'higher'
      ? options.currentValue < hysteresisThreshold
      : options.currentValue > hysteresisThreshold;

  if (shouldUpdate && isStableDowngrade(previous, options.nowIso)) {
    updateStateEntry(options.stateMap, key, options.level, options.nowIso);
  }
}

function updateStateEntry(stateMap: Map<string, AwsStateEntry>, key: string, level: EventLevels, nowIso: string): void {
  if (level === EventLevels.Info) {
    stateMap.delete(key);
    return;
  }
  stateMap.set(key, { level, lastAt: nowIso });
}

function buildRequestUrl(authKey: string): string {
  const url = new URL(KMA_AWS_ENDPOINT);
  url.search = new URLSearchParams({
    disp: '1',
    help: '2',
    authKey,
  }).toString();
  return url.toString();
}

function parseAwsRows(text: string): AwsRow[] {
  const lines = text.split('\n');
  const rows: AwsRow[] = [];

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) {
      continue;
    }

    const parts = trimmed.split(',');
    if (parts.length < 18) {
      continue;
    }

    const timestamp = parts[0]?.trim() ?? '';
    if (!/^\d{12}$/.test(timestamp)) {
      continue;
    }

    const stationCode = Number.parseInt(parts[1]?.trim() ?? '', 10);
    if (!Number.isFinite(stationCode)) {
      continue;
    }

    rows.push({
      timestamp,
      stationCode,
      wss: parseWindSpeed(parts[5]),
      ws10: parseWindSpeed(parts[7]),
      ta: parseTemperature(parts[8]),
      rn60m: parseRainAmount(parts[11], RAIN_60M_MAX_MM),
      rn12h: parseRainAmount(parts[12], RAIN_ACCUM_MAX_MM),
    });
  }

  return rows;
}

function parseWindSpeed(value: string | undefined): number | null {
  const parsed = parseNumber(value);
  if (parsed === null || parsed < 0 || parsed > WIND_SPEED_MAX_MS) {
    return null;
  }
  return parsed;
}

function parseTemperature(value: string | undefined): number | null {
  const parsed = parseNumber(value);
  if (parsed === null || parsed < TEMPERATURE_MIN_C || parsed > TEMPERATURE_MAX_C) {
    return null;
  }
  return parsed;
}

function parseRainAmount(value: string | undefined, maxValue: number): number | null {
  const parsed = parseNumber(value);
  if (parsed === null || parsed < 0 || parsed > maxValue) {
    return null;
  }
  return parsed;
}

function parseNumber(value: string | undefined): number | null {
  if (!value) {
    return null;
  }
  const trimmed = value.trim();
  if (trimmed.length === 0 || trimmed === '=') {
    return null;
  }
  const parsed = Number.parseFloat(trimmed);
  if (!Number.isFinite(parsed) || parsed <= -50) {
    return null;
  }
  return parsed;
}

function evaluateWindGust(row: AwsRow): WindGustEvaluation | null {
  if (row.wss === null) {
    return null;
  }

  return {
    level: resolveWindGustLevel(row.wss),
    speed: row.wss,
  };
}

function evaluateWindAvg(row: AwsRow): WindAvgEvaluation | null {
  if (row.ws10 !== null) {
    return {
      level: resolveWindAvgLevel(row.ws10),
      speed: row.ws10,
      basis: 'ws10',
    };
  }

  return null;
}

function evaluateRainIntensity(row: AwsRow): RainIntensityEvaluation | null {
  const resolved = resolveRainIntensity(row);
  if (!resolved) {
    return null;
  }

  return {
    level: resolveRainIntensityLevel(resolved.intensity),
    intensity: resolved.intensity,
    basis: resolved.basis,
    rn60m: row.rn60m,
  };
}

function evaluateRainAccum(row: AwsRow): RainAccumEvaluation | null {
  if (row.rn12h === null) {
    return null;
  }

  return {
    level: resolveRainAccumLevel(row.rn12h),
    rn12h: row.rn12h,
  };
}

function resolveWindGustLevel(gustSpeed: number): EventLevels {
  for (const threshold of WIND_THRESHOLDS) {
    if (gustSpeed >= threshold.gustMs) {
      return threshold.level;
    }
  }
  return EventLevels.Info;
}

function resolveWindAvgLevel(avgSpeed: number): EventLevels {
  for (const threshold of WIND_THRESHOLDS) {
    if (avgSpeed >= threshold.avgMs) {
      return threshold.level;
    }
  }
  return EventLevels.Info;
}

function resolveRainIntensityLevel(intensity: number): EventLevels {
  for (const threshold of RAIN_THRESHOLDS) {
    if (intensity >= threshold.intensity) {
      return threshold.level;
    }
  }
  return EventLevels.Info;
}

function resolveRainAccumLevel(rn12h: number): EventLevels {
  for (const threshold of RAIN_THRESHOLDS) {
    if (rn12h >= threshold.accum12h) {
      return threshold.level;
    }
  }
  return EventLevels.Info;
}

function resolveHeatLevel(tempC: number): EventLevels {
  for (const threshold of HEAT_THRESHOLDS) {
    if (tempC >= threshold.tempC) {
      return threshold.level;
    }
  }
  return EventLevels.Info;
}

function resolveColdLevel(tempC: number): EventLevels {
  for (const threshold of COLD_THRESHOLDS) {
    if (tempC <= threshold.tempC) {
      return threshold.level;
    }
  }
  return EventLevels.Info;
}

function resolveWindGustThreshold(level: EventLevels): number | null {
  for (const threshold of WIND_THRESHOLDS) {
    if (threshold.level === level) {
      return threshold.gustMs;
    }
  }
  return null;
}

function resolveWindAvgThreshold(level: EventLevels): number | null {
  for (const threshold of WIND_THRESHOLDS) {
    if (threshold.level === level) {
      return threshold.avgMs;
    }
  }
  return null;
}

function resolveRainIntensityThreshold(level: EventLevels): number | null {
  for (const threshold of RAIN_THRESHOLDS) {
    if (threshold.level === level) {
      return threshold.intensity;
    }
  }
  return null;
}

function resolveRainAccumThreshold(level: EventLevels): number | null {
  for (const threshold of RAIN_THRESHOLDS) {
    if (threshold.level === level) {
      return threshold.accum12h;
    }
  }
  return null;
}

function resolveHeatThreshold(level: EventLevels): number | null {
  for (const threshold of HEAT_THRESHOLDS) {
    if (threshold.level === level) {
      return threshold.tempC;
    }
  }
  return null;
}

function resolveColdThreshold(level: EventLevels): number | null {
  for (const threshold of COLD_THRESHOLDS) {
    if (threshold.level === level) {
      return threshold.tempC;
    }
  }
  return null;
}

function resolveRainIntensity(row: AwsRow): { intensity: number; basis: 'rn60m' } | null {
  if (row.rn60m === null) {
    return null;
  }
  return { intensity: row.rn60m, basis: 'rn60m' };
}

function buildWindEvent(
  row: AwsRow,
  wind: WindGustEvaluation | WindAvgEvaluation,
  metric: 'gust' | 'avg_ws1' | 'avg_ws10',
  stationInfo: StationInfo | null,
  occurredAt: string | null,
): SourceEvent {
  const stationName = resolveStationName(stationInfo, row.stationCode);
  const label = metric === 'gust' ? '순간' : metric === 'avg_ws1' ? '1분 평균' : '10분 평균';
  const titleValue = `${label} 풍속 ${formatNumber(wind.speed)} m/s 관측`;
  const body = buildAddressBody(stationInfo);

  return {
    kind: EventKinds.Wind,
    title: `${stationName} ${titleValue}`.trim(),
    body,
    occurredAt,
    regionText: buildRegionText(stationInfo),
    geo: buildGeo(stationInfo),
    level: wind.level,
    payload: buildPayload({
      stationCode: row.stationCode,
      stationInfo,
      observedAt: row.timestamp,
      observedAtIso: occurredAt,
      category: metric === 'gust' ? 'wind_gust' : 'wind_avg',
      metrics: {
        speed: wind.speed,
        ws10: row.ws10,
        wss: row.wss,
      },
    }),
  };
}

function buildRainIntensityEvent(
  row: AwsRow,
  rain: RainIntensityEvaluation,
  stationInfo: StationInfo | null,
  occurredAt: string | null,
): SourceEvent {
  const stationName = resolveStationName(stationInfo, row.stationCode);
  const titleValue = `시간당 강수 ${formatNumber(rain.rn60m ?? rain.intensity, 0)} mm 관측`;
  const body = buildAddressBody(stationInfo);

  return {
    kind: EventKinds.Rain,
    title: `${stationName} ${titleValue}`.trim(),
    body,
    occurredAt,
    regionText: buildRegionText(stationInfo),
    geo: buildGeo(stationInfo),
    level: rain.level,
    payload: buildPayload({
      stationCode: row.stationCode,
      stationInfo,
      observedAt: row.timestamp,
      observedAtIso: occurredAt,
      category: 'rain_intensity',
      metrics: {
        intensity: rain.intensity,
        rn60m: rain.rn60m,
      },
    }),
  };
}

function buildRainAccumEvent(
  row: AwsRow,
  rain: RainAccumEvaluation,
  stationInfo: StationInfo | null,
  occurredAt: string | null,
): SourceEvent {
  const stationName = resolveStationName(stationInfo, row.stationCode);
  const titleValue = `12시간 강수 ${formatNumber(rain.rn12h, 0)} mm 관측`;
  const body = buildAddressBody(stationInfo);

  return {
    kind: EventKinds.Rain,
    title: `${stationName} ${titleValue}`.trim(),
    body,
    occurredAt,
    regionText: buildRegionText(stationInfo),
    geo: buildGeo(stationInfo),
    level: rain.level,
    payload: buildPayload({
      stationCode: row.stationCode,
      stationInfo,
      observedAt: row.timestamp,
      observedAtIso: occurredAt,
      category: 'rain_accum',
      metrics: {
        rn12h: rain.rn12h,
      },
    }),
  };
}

function buildTemperatureEvent(
  row: AwsRow,
  temperature: TemperatureEvaluation,
  stationInfo: StationInfo | null,
  occurredAt: string | null,
): SourceEvent {
  const stationName = resolveStationName(stationInfo, row.stationCode);
  const titleValue = `${formatNumber(temperature.temperature)} ℃ 관측`;
  const body = buildAddressBody(stationInfo);

  return {
    kind: temperature.kind,
    title: `${stationName} 기온 ${titleValue}`.trim(),
    body,
    occurredAt,
    regionText: buildRegionText(stationInfo),
    geo: buildGeo(stationInfo),
    level: temperature.level,
    payload: buildPayload({
      stationCode: row.stationCode,
      stationInfo,
      observedAt: row.timestamp,
      observedAtIso: occurredAt,
      category: temperature.kind === EventKinds.Heat ? 'heat' : 'cold',
      metrics: {
        temperature: temperature.temperature,
      },
    }),
  };
}

type PayloadOptions = {
  stationCode: number;
  stationInfo: StationInfo | null;
  observedAt: string;
  observedAtIso: string | null;
  category: string;
  metrics: Record<string, number | null>;
};

function buildPayload(options: PayloadOptions): EventPayload {
  return {
    stationCode: options.stationCode,
    stationName: normalizeText(options.stationInfo?.name),
    stationAddress: normalizeText(options.stationInfo?.address),
    stationLat: options.stationInfo?.lat ?? null,
    stationLng: options.stationInfo?.lng ?? null,
    observedAt: options.observedAt,
    observedAtIso: options.observedAtIso,
    category: options.category,
    metrics: options.metrics,
  };
}

function resolveStationName(stationInfo: StationInfo | null, stationCode: number): string {
  const name = normalizeText(stationInfo?.name);
  return name ?? `관측소 ${stationCode}`;
}

function buildRegionText(stationInfo: StationInfo | null): string | null {
  return normalizeText(stationInfo?.address);
}

function buildAddressBody(stationInfo: StationInfo | null): string | null {
  const address = normalizeText(stationInfo?.address);
  if (!address) {
    return null;
  }
  const altitude = stationInfo?.altitudeM;
  if (altitude === null || altitude === undefined) {
    return `관측 지점: ${address}`;
  }
  return `관측 지점: ${address} (해발고도 ${formatAltitude(altitude)}m)`;
}

function buildGeo(stationInfo: StationInfo | null) {
  if (stationInfo?.lat === null || stationInfo?.lng === null) {
    return null;
  }
  if (stationInfo?.lat === undefined || stationInfo?.lng === undefined) {
    return null;
  }
  return { lat: stationInfo.lat, lng: stationInfo.lng };
}

async function resolveStationInfo(
  stationCode: number,
  repository: IStationRepository,
  cache: Map<number, StationInfo | null>,
): Promise<StationInfo | null> {
  if (cache.has(stationCode)) {
    return cache.get(stationCode) ?? null;
  }
  const station = await repository.findByCode(stationCode);
  cache.set(stationCode, station);
  return station;
}

function formatNumber(value: number, digits: number = 1): string {
  return value.toFixed(digits);
}

function formatAltitude(value: number): string {
  const digits = Number.isInteger(value) ? 0 : 1;
  return value.toFixed(digits);
}

function parseKstCompactTimestamp(value: string): string | null {
  const matched = value.match(/^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})$/);
  if (!matched) {
    return null;
  }

  const [, year, month, day, hour, minute] = matched;
  const utcMs = Date.UTC(Number(year), Number(month) - 1, Number(day), Number(hour) - 9, Number(minute), 0);
  const date = new Date(utcMs);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function parseState(state: string | null): AwsState {
  if (!state) {
    return { entries: {} };
  }

  try {
    const parsed = JSON.parse(state) as unknown;
    const result = schemaAwsState.safeParse(parsed);
    if (!result.success) {
      logger.warn({ error: result.error }, 'Failed to parse KMA AWS checkpoint state');
      return { entries: {} };
    }
    return result.data;
  } catch (error) {
    logger.warn({ error }, 'Failed to parse KMA AWS checkpoint state');
    return { entries: {} };
  }
}

function buildState(stateMap: Map<string, AwsStateEntry>): string | null {
  return JSON.stringify({ entries: Object.fromEntries(stateMap) });
}

function buildStateKey(metricKey: MetricKey, stationCode: number): string {
  return `${metricKey}:${stationCode}`;
}

function isStableDowngrade(previous: AwsStateEntry, nowIso: string): boolean {
  const previousMs = Date.parse(previous.lastAt);
  const nowMs = Date.parse(nowIso);
  if (!Number.isFinite(previousMs) || !Number.isFinite(nowMs)) {
    return true;
  }
  return nowMs - previousMs >= DOWNGRADE_STABLE_WAIT_MS;
}
