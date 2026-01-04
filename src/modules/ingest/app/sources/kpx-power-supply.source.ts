import { load } from 'cheerio';
import { z } from 'zod';
import { logger } from '@/core/logger';
import type { EventPayload } from '@/modules/events/domain/entity/event.entity';
import { EventKinds, EventLevels, EventSources } from '@/modules/events/domain/event.enums';
import type { Source, SourceEvent, SourceRunResult } from '../../domain/port/source.interface';
import { fetchWithTimeout } from './_shared/fetch-with-timeout';
import { normalizeText } from './_shared/normalize';

const KPX_POWER_SUPPLY_ENDPOINT = 'https://new.kpx.or.kr/maxloadForecast.es';
const REQUEST_TIMEOUT_MS = 15000;
const DOWNGRADE_DELAY_MS = 1000 * 60 * 60;

const STAGE_ORDER = ['정상', '준비', '관심', '주의', '경계', '심각'] as const;

type StageLabel = (typeof STAGE_ORDER)[number];

type PowerSupplyState = {
  stage: StageLabel;
  confirmedAt: string;
};

const schemaPowerSupplyState = z.object({
  stage: z.string().min(1),
  confirmedAt: z.string().min(1),
});

export class KpxPowerSupplySource implements Source {
  public readonly sourceId = EventSources.KpxPowerSupply;
  public readonly pollIntervalSec = 60 * 10;

  public async run(state: string | null): Promise<SourceRunResult> {
    const now = new Date();
    const nowIso = now.toISOString();
    const nowMs = now.getTime();

    const response = await fetchWithTimeout({
      url: KPX_POWER_SUPPLY_ENDPOINT,
      timeoutMs: REQUEST_TIMEOUT_MS,
    });
    if (!response) {
      throw new Error('KPX power supply request failed');
    }

    const html = await response.text();
    const currentStage = parseStage(html);
    const currentIndex = STAGE_ORDER.indexOf(currentStage);

    const previousState = parseState(state);
    if (!previousState) {
      return { events: [], nextState: buildState(currentStage, nowIso) };
    }

    const previousIndex = STAGE_ORDER.indexOf(previousState.stage);
    if (currentIndex === previousIndex) {
      return { events: [], nextState: buildState(currentStage, nowIso) };
    }

    if (currentIndex > previousIndex) {
      const event = buildEvent('up', previousState, currentStage, nowIso);
      return { events: [event], nextState: buildState(currentStage, nowIso) };
    }

    const confirmedAtMs = Date.parse(previousState.confirmedAt);
    if (!Number.isFinite(confirmedAtMs)) {
      logger.warn({ confirmedAt: previousState.confirmedAt }, 'Invalid KPX power supply confirmedAt timestamp');
      return { events: [], nextState: buildState(currentStage, nowIso) };
    }

    if (nowMs - confirmedAtMs < DOWNGRADE_DELAY_MS) {
      return { events: [], nextState: state };
    }

    const event = buildEvent('down', previousState, currentStage, nowIso);
    return { events: [event], nextState: buildState(currentStage, nowIso) };
  }
}

function parseStage(html: string): StageLabel {
  const $ = load(html);
  const rawText = normalizeText($('.title ~ .step').first().text());
  const stage = parseStageLabel(rawText);
  if (!stage) {
    logger.warn({ rawText }, 'Failed to parse KPX power supply stage');
    throw new Error('Failed to parse KPX power supply stage');
  }

  return stage;
}

function parseStageLabel(value: string | null): StageLabel | null {
  const normalized = normalizeText(value);
  if (!normalized) {
    return null;
  }

  for (const stage of STAGE_ORDER) {
    if (normalized.includes(stage)) {
      return stage;
    }
  }

  return null;
}

function buildEvent(
  direction: 'up' | 'down',
  previousState: PowerSupplyState,
  currentStage: StageLabel,
  occurredAt: string,
): SourceEvent {
  const title = `전력수급현황 ${previousState.stage}→${currentStage} ${direction === 'up' ? '상향' : '하향'}`;
  return {
    kind: EventKinds.Energy,
    title,
    body: null,
    occurredAt,
    regionText: null,
    level: direction === 'down' ? EventLevels.Info : mapStageLevel(currentStage),
    payload: buildPayload(previousState, currentStage, direction, occurredAt),
  };
}

function buildPayload(
  previousState: PowerSupplyState,
  currentStage: StageLabel,
  direction: 'up' | 'down',
  occurredAt: string,
): EventPayload {
  return {
    previousStage: previousState.stage,
    currentStage,
    direction,
    previousConfirmedAt: previousState.confirmedAt,
    observedAt: occurredAt,
  };
}

function mapStageLevel(stage: StageLabel): EventLevels {
  switch (stage) {
    case '심각':
      return EventLevels.Severe;
    case '경계':
      return EventLevels.Moderate;
    case '주의':
    case '관심':
      return EventLevels.Minor;
    case '준비':
    case '정상':
      return EventLevels.Info;
  }
}

function parseState(state: string | null): PowerSupplyState | null {
  if (!state) {
    return null;
  }

  try {
    const parsed = schemaPowerSupplyState.safeParse(JSON.parse(state));
    if (!parsed.success) {
      logger.warn({ error: parsed.error }, 'Failed to parse KPX power supply checkpoint state');
      return null;
    }

    const stage = parseStageLabel(parsed.data.stage);
    if (!stage) {
      logger.warn({ stage: parsed.data.stage }, 'Invalid KPX power supply stage in checkpoint');
      return null;
    }

    if (!Number.isFinite(Date.parse(parsed.data.confirmedAt))) {
      logger.warn({ confirmedAt: parsed.data.confirmedAt }, 'Invalid KPX power supply confirmedAt in checkpoint');
      return null;
    }

    return {
      stage,
      confirmedAt: parsed.data.confirmedAt,
    };
  } catch (error) {
    logger.warn({ error }, 'Failed to parse KPX power supply checkpoint state');
    return null;
  }
}

function buildState(stage: StageLabel, confirmedAt: string): string {
  return JSON.stringify({ stage, confirmedAt });
}
