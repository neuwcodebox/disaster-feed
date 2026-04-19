import { z } from 'zod';
import { logger } from '@/core/logger';
import type { EventPayload } from '@/modules/events/domain/entity/event.entity';
import { EventKinds, EventLevels, EventSources } from '@/modules/events/domain/event.enums';
import type { Source, SourceEvent, SourceRunResult } from '../../domain/port/source.interface';
import { fetchWithTimeout } from './_shared/fetch-with-timeout';

const KASA_SPACE_WEATHER_ENDPOINT = 'https://spaceweather.kasa.go.kr/api/warn';
const REQUEST_TIMEOUT_MS = 30000;
const DOWNGRADE_DELAY_MS = 1000 * 60 * 60;

const WARN_TYPES = [
  { key: 'R', name: '태양흑점폭발' },
  { key: 'S', name: '태양입자유입' },
  { key: 'G', name: '지자기교란' },
] as const;

type WarnKey = (typeof WARN_TYPES)[number]['key'];

type WarnState = {
  level: number;
  confirmedAt: string;
};

type SpaceWeatherState = {
  warns: Record<WarnKey, WarnState>;
};

const schemaWarnItem = z
  .object({
    v0: z.string().min(1),
  })
  .loose();

const schemaSpaceWeatherResponse = z.object({
  Warn: z.object({
    R: schemaWarnItem,
    S: schemaWarnItem,
    G: schemaWarnItem,
  }),
  LastUpdate: z.string().min(1),
  Error: z.boolean(),
  ErrorCode: z.string().min(1),
});

const schemaWarnState = z.object({
  level: z.number().int().nonnegative(),
  confirmedAt: z.string().min(1),
});

const schemaSpaceWeatherState = z.object({
  warns: z.object({
    R: schemaWarnState,
    S: schemaWarnState,
    G: schemaWarnState,
  }),
});

type SpaceWeatherResponse = z.infer<typeof schemaSpaceWeatherResponse>;

export class KasaSpaceWeatherWarningSource implements Source {
  public readonly sourceId = EventSources.KasaSpaceWeatherWarning;
  public readonly pollIntervalSec = 60 * 3;

  public async run(state: string | null): Promise<SourceRunResult> {
    const now = new Date();
    const nowIso = now.toISOString();
    const nowMs = now.getTime();

    const response = await fetchWithTimeout({
      url: KASA_SPACE_WEATHER_ENDPOINT,
      timeoutMs: REQUEST_TIMEOUT_MS,
      useInsecureTls: true,
      init: {
        headers: {
          Accept: 'application/json',
        },
      },
    });
    if (!response) {
      throw new Error('KASA space weather warning request failed');
    }

    const rawText = await response.text();
    const data = parseResponseJson(rawText);
    const parsed = schemaSpaceWeatherResponse.safeParse(data);
    if (!parsed.success) {
      logger.warn({ error: parsed.error }, 'Failed to validate KASA space weather warning response');
      throw new Error('Failed to validate KASA space weather warning response');
    }

    if (parsed.data.Error || parsed.data.ErrorCode !== 'NOERR') {
      logger.warn(
        { error: parsed.data.Error, errorCode: parsed.data.ErrorCode },
        'KASA space weather warning response error',
      );
      throw new Error('KASA space weather warning response error');
    }

    const currentLevels = parseCurrentLevels(parsed.data);
    const previousState = parseState(state);
    const observedAt = resolveObservedAt(parsed.data.LastUpdate, nowIso);

    if (!previousState) {
      return { events: [], nextState: buildInitialState(currentLevels, nowIso) };
    }

    const events: SourceEvent[] = [];
    const nextWarns: Record<WarnKey, WarnState> = {
      R: previousState.warns.R,
      S: previousState.warns.S,
      G: previousState.warns.G,
    };

    for (const warn of WARN_TYPES) {
      const currentLevel = currentLevels[warn.key];
      const previousWarn = previousState.warns[warn.key];
      const nextWarn = evaluateWarnState({
        warn,
        currentLevel,
        previousWarn,
        nowIso,
        nowMs,
        observedAt,
        events,
      });
      nextWarns[warn.key] = nextWarn;
    }

    return { events, nextState: JSON.stringify({ warns: nextWarns }) };
  }
}

type WarnSpec = (typeof WARN_TYPES)[number];

type EvaluateWarnParams = {
  warn: WarnSpec;
  currentLevel: number;
  previousWarn: WarnState;
  nowIso: string;
  nowMs: number;
  observedAt: string;
  events: SourceEvent[];
};

function parseResponseJson(rawText: string): unknown {
  try {
    return JSON.parse(rawText);
  } catch (error) {
    logger.warn({ error, sample: rawText.slice(0, 200) }, 'Failed to parse KASA space weather response');
    throw new Error('Failed to parse KASA space weather response');
  }
}

function parseCurrentLevels(data: SpaceWeatherResponse): Record<WarnKey, number> {
  const levels: Record<WarnKey, number | null> = {
    R: parseWarnLevel(data.Warn.R.v0, 'R'),
    S: parseWarnLevel(data.Warn.S.v0, 'S'),
    G: parseWarnLevel(data.Warn.G.v0, 'G'),
  };

  const currentLevels: Record<WarnKey, number> = { R: 0, S: 0, G: 0 };
  for (const warn of WARN_TYPES) {
    const level = levels[warn.key];
    if (level === null) {
      throw new Error(`Failed to parse ${warn.key} level from space weather response`);
    }
    currentLevels[warn.key] = level;
  }

  return currentLevels;
}

function parseWarnLevel(value: string, warnKey: WarnKey): number | null {
  const normalized = value.trim().toUpperCase();
  if (!normalized.startsWith(warnKey)) {
    return null;
  }

  const levelText = normalized.slice(warnKey.length);
  const level = Number.parseInt(levelText, 10);
  if (!Number.isFinite(level) || level < 0) {
    return null;
  }

  return level;
}

function resolveObservedAt(lastUpdate: string, fallbackIso: string): string {
  const timestampMs = Number.parseInt(lastUpdate, 10);
  if (!Number.isFinite(timestampMs)) {
    logger.warn({ lastUpdate }, 'Invalid KASA space weather last update');
    return fallbackIso;
  }

  const observedAt = new Date(timestampMs);
  if (Number.isNaN(observedAt.getTime())) {
    logger.warn({ lastUpdate }, 'Invalid KASA space weather last update');
    return fallbackIso;
  }

  return observedAt.toISOString();
}

function buildInitialState(levels: Record<WarnKey, number>, confirmedAt: string): string {
  return JSON.stringify({
    warns: {
      R: { level: levels.R, confirmedAt },
      S: { level: levels.S, confirmedAt },
      G: { level: levels.G, confirmedAt },
    },
  });
}

function evaluateWarnState(params: EvaluateWarnParams): WarnState {
  const { warn, currentLevel, previousWarn, nowIso, nowMs, observedAt, events } = params;

  if (currentLevel === previousWarn.level) {
    return { level: currentLevel, confirmedAt: nowIso };
  }

  if (currentLevel > previousWarn.level) {
    events.push(buildEvent(warn, 'up', previousWarn.level, currentLevel, observedAt));
    return { level: currentLevel, confirmedAt: nowIso };
  }

  const confirmedAtMs = Date.parse(previousWarn.confirmedAt);
  if (!Number.isFinite(confirmedAtMs)) {
    logger.warn({ confirmedAt: previousWarn.confirmedAt }, 'Invalid KASA space weather confirmedAt');
    return { level: currentLevel, confirmedAt: nowIso };
  }

  if (nowMs - confirmedAtMs < DOWNGRADE_DELAY_MS) {
    return previousWarn;
  }

  events.push(buildEvent(warn, 'down', previousWarn.level, currentLevel, observedAt));
  return { level: currentLevel, confirmedAt: nowIso };
}

function buildEvent(
  warn: WarnSpec,
  direction: 'up' | 'down',
  previousLevel: number,
  currentLevel: number,
  occurredAt: string,
): SourceEvent {
  return {
    kind: EventKinds.SpaceWeather,
    title: buildTitle(warn.name, previousLevel, currentLevel, direction),
    body: null,
    occurredAt,
    regionText: null,
    level: direction === 'down' ? EventLevels.Info : mapLevel(currentLevel),
    payload: buildPayload(warn, direction, previousLevel, currentLevel, occurredAt),
  };
}

function buildTitle(name: string, previousLevel: number, currentLevel: number, direction: 'up' | 'down'): string {
  if (direction === 'up') {
    return `${name} ${currentLevel}단계 경보 상황 발생`;
  }
  return `${name} ${previousLevel}단계 경보 상황 종료 (현재 ${currentLevel}단계)`;
}

function mapLevel(level: number): EventLevels {
  if (level <= 0) {
    return EventLevels.Info;
  }
  if (level === 1) {
    return EventLevels.Info;
  }
  if (level === 2) {
    return EventLevels.Minor;
  }
  if (level === 3) {
    return EventLevels.Minor;
  }
  if (level === 4) {
    return EventLevels.Moderate;
  }
  return EventLevels.Moderate;
}

function buildPayload(
  warn: WarnSpec,
  direction: 'up' | 'down',
  previousLevel: number,
  currentLevel: number,
  occurredAt: string,
): EventPayload {
  return {
    warnKey: warn.key,
    warnName: warn.name,
    direction,
    previousLevel,
    currentLevel,
    observedAt: occurredAt,
  };
}

function parseState(state: string | null): SpaceWeatherState | null {
  if (!state) {
    return null;
  }

  try {
    const parsed = schemaSpaceWeatherState.safeParse(JSON.parse(state));
    if (!parsed.success) {
      logger.warn({ error: parsed.error }, 'Failed to parse KASA space weather checkpoint state');
      return null;
    }

    for (const warn of WARN_TYPES) {
      const confirmedAt = parsed.data.warns[warn.key].confirmedAt;
      if (!Number.isFinite(Date.parse(confirmedAt))) {
        logger.warn({ confirmedAt }, 'Invalid KASA space weather confirmedAt in checkpoint');
        return null;
      }
    }

    return parsed.data;
  } catch (error) {
    logger.warn({ error }, 'Failed to parse KASA space weather checkpoint state');
    return null;
  }
}
