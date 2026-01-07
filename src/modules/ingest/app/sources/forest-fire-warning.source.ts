import { z } from 'zod';
import { logger } from '@/core/logger';
import { EventKinds, EventLevels, EventSources } from '@/modules/events/domain/event.enums';
import type { Source, SourceEvent, SourceRunResult } from '../../domain/port/source.interface';
import { fetchWithTimeout } from './_shared/fetch-with-timeout';
import { normalizeText } from './_shared/normalize';

const FOREST_FIRE_WARNING_ENDPOINT = 'https://fd.forest.go.kr/ffas/new/getFireWarningList.do';
const REQUEST_TIMEOUT_MS = 15000;
const NATIONAL_REGION_LABEL = '전국';

const schemaFireWarningItem = z
  .object({
    frfr_wrnng_step_cd: z.string().optional().nullable(),
    frfr_wrnng_issu_dtm: z.string().optional().nullable(),
    lgdng_cd: z.string().optional().nullable(),
    frfr_wrnng_issu_rsn: z.string().optional().nullable(),
  })
  .loose();

const schemaFireWarningResponse = z.object({
  fireWarningList: z.array(schemaFireWarningItem).optional().default([]),
});

const schemaFireWarningState = z.object({
  stepLabel: z.string().min(1),
  issuedAt: z.string().min(1),
});

type FireWarningItem = z.infer<typeof schemaFireWarningItem>;

type FireWarningState = {
  stepLabel: string;
  issuedAt: string;
};

export class ForestFireWarningSource implements Source {
  public readonly sourceId = EventSources.ForestFireWarning;
  public readonly pollIntervalSec = 60 * 10;

  public async run(state: string | null): Promise<SourceRunResult> {
    const response = await fetchWithTimeout({
      url: FOREST_FIRE_WARNING_ENDPOINT,
      init: {
        headers: {
          Accept: 'application/json',
        },
      },
      timeoutMs: REQUEST_TIMEOUT_MS,
    });
    if (!response) {
      throw new Error('Forest fire warning request failed');
    }

    const rawText = await response.text();
    const data = parseResponseJson(rawText);
    const parsed = schemaFireWarningResponse.safeParse(data);
    if (!parsed.success) {
      logger.warn({ error: parsed.error }, 'Failed to validate forest fire warning response');
      throw new Error('Failed to validate forest fire warning response');
    }

    const item = pickNationalWarning(parsed.data.fireWarningList);
    if (!item) {
      throw new Error('No national forest fire warning found');
    }

    const stepLabel = normalizeText(item.frfr_wrnng_step_cd);
    const issuedAt = normalizeText(item.frfr_wrnng_issu_dtm);
    if (!stepLabel || !issuedAt) {
      throw new Error('Forest fire warning item is missing required fields');
    }

    const currentState: FireWarningState = { stepLabel, issuedAt };
    const nextState = buildState(currentState);
    const previousState = parseState(state);

    if (previousState && isSameState(previousState, currentState)) {
      return { events: [], nextState };
    }

    return {
      events: [buildEvent(item, currentState)],
      nextState,
    };
  }
}

function parseResponseJson(rawText: string): unknown {
  try {
    return JSON.parse(rawText);
  } catch (error) {
    logger.warn({ error, sample: rawText.slice(0, 200) }, 'Failed to parse forest fire warning response');
    throw new Error('Failed to parse forest fire warning response');
  }
}

function pickNationalWarning(items: FireWarningItem[]): FireWarningItem | null {
  for (const item of items) {
    const region = normalizeText(item.lgdng_cd);
    if (region === NATIONAL_REGION_LABEL) {
      return item;
    }
  }
  return null;
}

function buildEvent(item: FireWarningItem, state: FireWarningState): SourceEvent {
  const regionText = normalizeText(item.lgdng_cd) ?? NATIONAL_REGION_LABEL;
  const occurredAt = parseKstDateTime(state.issuedAt);

  return {
    kind: EventKinds.Wildfire,
    title: buildTitle(regionText, state.stepLabel),
    body: buildBody(state.issuedAt),
    occurredAt,
    regionText,
    level: mapWarningLevel(state.stepLabel),
    payload: item,
  };
}

function buildTitle(regionText: string, stepLabel: string): string {
  return `${regionText} 산불경보 ${stepLabel} 단계 발령`;
}

function buildBody(issuedAt: string): string {
  return `발령 시각: ${issuedAt}`;
}

function mapWarningLevel(stepLabel: string): EventLevels {
  const normalized = normalizeText(stepLabel);
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
  if (normalized.includes('관심')) {
    return EventLevels.Info;
  }

  return EventLevels.Info;
}

function parseKstDateTime(value: string): string | null {
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

function parseState(state: string | null): FireWarningState | null {
  if (!state) {
    return null;
  }

  try {
    const parsed = schemaFireWarningState.safeParse(JSON.parse(state));
    if (!parsed.success) {
      logger.warn({ error: parsed.error }, 'Failed to parse forest fire warning checkpoint state');
      return null;
    }

    return parsed.data;
  } catch (error) {
    logger.warn({ error }, 'Failed to parse forest fire warning checkpoint state');
    return null;
  }
}

function buildState(state: FireWarningState): string {
  return JSON.stringify(state);
}

function isSameState(left: FireWarningState, right: FireWarningState): boolean {
  return left.stepLabel === right.stepLabel && left.issuedAt === right.issuedAt;
}
