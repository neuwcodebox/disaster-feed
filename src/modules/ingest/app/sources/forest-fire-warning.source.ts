import { z } from 'zod';
import { logger } from '@/core/logger';
import { EventKinds, EventLevels, EventSources } from '@/modules/events/domain/event.enums';
import type { Source, SourceEvent, SourceRunResult } from '../../domain/port/source.interface';
import { fetchWithTimeout } from './_shared/fetch-with-timeout';
import { isTooOld } from './_shared/is-too-old';
import { normalizeText } from './_shared/normalize';
import { pruneTimedMap } from './_shared/prune-timed-map';

const FOREST_FIRE_WARNING_ENDPOINT = 'https://fd.forest.go.kr/ffas/new/getFireWarningList.do';
const REQUEST_TIMEOUT_MS = 15000;
const STATE_TTL_MS = 1000 * 60 * 60 * 24;
const EVENT_MAX_AGE_MS = STATE_TTL_MS * 0.9;

const schemaFireWarningItem = z
  .object({
    frfr_wrnng_id: z.string().nullish(),
    frfr_wrnng_step_cd: z.string().nullish(),
    frfr_wrnng_rgstn_dtm: z.string().nullish(),
    frfr_wrnng_issu_dtm: z.string().nullish(),
    frfr_wrnng_issu_rsn: z.string().nullish(),
    lgdng_ctprv_cd: z.string().nullish(),
    lgdng_nm: z.string().nullish(),
    lgdng_sgng_cd: z.string().nullish(),
    loest_ara_nm: z.string().nullish(),
  })
  .loose();

const schemaFireWarningResponse = z.object({
  fireWarningList: z.array(schemaFireWarningItem).optional().default([]),
});

const schemaFireWarningState = z.object({
  seen: z.record(z.string(), z.string()),
});

type FireWarningItem = z.infer<typeof schemaFireWarningItem>;

type FireWarningState = {
  seen: Record<string, string>;
};

type FireWarningGroup = {
  ctprvCode: string;
  stepLabel: string;
  items: FireWarningItem[];
  occurredAt: string;
  issuedAt: string;
  regionNames: string[];
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

    const previousState = parseState(state);
    const now = new Date();
    const nowIso = now.toISOString();
    const nowMs = now.getTime();

    const seen = new Map<string, string>(Object.entries(previousState?.seen ?? {}));
    const groups = new Map<string, FireWarningGroup>();

    for (const item of parsed.data.fireWarningList) {
      const warningId = normalizeText(item.frfr_wrnng_id);
      if (!warningId) {
        continue;
      }

      const occurredAt = parseKstDateTime(normalizeText(item.frfr_wrnng_rgstn_dtm));
      const issuedAt = normalizeText(item.frfr_wrnng_issu_dtm);
      if (!occurredAt || !issuedAt) {
        continue;
      }

      const isSeen = seen.has(warningId);
      const isExpired = isTooOld(occurredAt, nowMs, EVENT_MAX_AGE_MS);

      if (isExpired) {
        continue;
      }

      seen.set(warningId, nowIso);

      if (!previousState || isSeen) {
        continue;
      }

      const stepLabel = normalizeText(item.frfr_wrnng_step_cd);
      const ctprvCode = normalizeText(item.lgdng_ctprv_cd);
      if (!stepLabel || !ctprvCode) {
        continue;
      }

      const groupKey = buildGroupKey(ctprvCode, stepLabel, occurredAt, issuedAt);
      const group = groups.get(groupKey) ?? createGroup(ctprvCode, stepLabel, occurredAt, issuedAt);
      group.items.push(item);

      const regionName = resolveRegionName(item);
      if (regionName && !group.regionNames.includes(regionName)) {
        group.regionNames.push(regionName);
      }

      groups.set(groupKey, group);
    }

    pruneTimedMap(seen, nowMs, STATE_TTL_MS);
    const nextState = buildState(seen);

    if (!previousState) {
      return { events: [], nextState };
    }

    const events = Array.from(groups.values()).map(buildEvent);

    return {
      events,
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

function createGroup(ctprvCode: string, stepLabel: string, occurredAt: string, issuedAt: string): FireWarningGroup {
  return {
    ctprvCode,
    stepLabel,
    items: [],
    occurredAt,
    issuedAt,
    regionNames: [],
  };
}

function buildEvent(group: FireWarningGroup): SourceEvent {
  const ctprvName = resolveCtprvName(group.items);
  const regionText = ctprvName ?? group.ctprvCode;

  return {
    kind: EventKinds.Wildfire,
    title: buildTitle(regionText, group.stepLabel),
    body: buildBody(group.issuedAt, group.regionNames, ctprvName),
    occurredAt: group.occurredAt,
    regionText,
    level: mapWarningLevel(group.stepLabel),
    payload: { items: group.items },
  };
}

function buildTitle(regionText: string, stepLabel: string): string {
  const normalizedRegion = normalizeText(regionText);
  const normalizedStep = normalizeText(stepLabel);
  const parts = [normalizedRegion, '산불경보', normalizedStep, '단계 발령'].filter((value): value is string =>
    Boolean(value),
  );

  return parts.join(' ').trim() || '산불경보 단계 발령';
}

function buildBody(issuedAt: string, regionNames: string[], ctprvName: string | null): string | null {
  const lines: string[] = [];
  lines.push(`발령 시각: ${issuedAt}`);

  const compactRegionNames = compactRegionNamesForBody(regionNames, ctprvName);
  if (compactRegionNames.length > 0) {
    lines.push(`대상 지역: ${compactRegionNames.join(', ')}`);
  }

  return lines.length > 0 ? lines.join('\n') : null;
}

function resolveRegionName(item: FireWarningItem): string | null {
  return normalizeText(item.loest_ara_nm) ?? normalizeText(item.lgdng_nm);
}

function compactRegionNamesForBody(regionNames: string[], ctprvName: string | null): string[] {
  const compacted: string[] = [];
  const prefix = ctprvName ? `${ctprvName} ` : null;

  for (const name of regionNames) {
    let resolved = name;
    if (prefix && resolved.startsWith(prefix)) {
      resolved = resolved.slice(prefix.length).trim();
    }
    if (!resolved) {
      continue;
    }
    if (!compacted.includes(resolved)) {
      compacted.push(resolved);
    }
  }

  return compacted;
}

function resolveCtprvName(items: FireWarningItem[]): string | null {
  let fallback: string | null = null;

  for (const item of items) {
    const name = resolveCtprvCandidateName(item);
    if (!name) {
      continue;
    }

    if (normalizeText(item.lgdng_sgng_cd) === '000') {
      return extractCtprvName(name);
    }

    if (!fallback) {
      fallback = name;
    }
  }

  return fallback ? extractCtprvName(fallback) : null;
}

function resolveCtprvCandidateName(item: FireWarningItem): string | null {
  return normalizeText(item.lgdng_nm) ?? normalizeText(item.loest_ara_nm);
}

function extractCtprvName(name: string): string {
  return name.split(' ')[0];
}

function buildGroupKey(ctprvCode: string, stepLabel: string, occurredAt: string, issuedAt: string): string {
  return `${ctprvCode}|${stepLabel}|${occurredAt}|${issuedAt}`;
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

function parseKstDateTime(value: string | null): string | null {
  const normalized = normalizeText(value);
  if (!normalized) {
    return null;
  }

  const matched = normalized.match(/^\s*(\d{4})-(\d{2})-(\d{2})\s+(\d{2}):(\d{2})(?::(\d{2}))?\s*$/);
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

function buildState(seen: Map<string, string>): string {
  return JSON.stringify({
    seen: Object.fromEntries(seen),
  });
}
