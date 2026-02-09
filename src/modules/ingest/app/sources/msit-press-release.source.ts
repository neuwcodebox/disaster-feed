import { load } from 'cheerio';
import { logger } from '@/core/logger';
import type { EventPayload } from '@/modules/events/domain/entity/event.entity';
import { EventKinds, EventLevels, EventSources } from '@/modules/events/domain/event.enums';
import type { Source, SourceEvent, SourceRunResult } from '../../domain/port/source.interface';
import type { LlmLabelClassifierService } from '../llm-label-classifier.service';
import { DISASTER_KIND_BY_NAME, DISASTER_KIND_LABELS } from './_shared/disaster-kind-labels';
import { fetchWithTimeout } from './_shared/fetch-with-timeout';
import { isTooOld } from './_shared/is-too-old';
import { normalizeText } from './_shared/normalize';
import { pruneTimedMap } from './_shared/prune-timed-map';
import { resolveDateOnlyWithServerTime } from './_shared/resolve-date-only-with-server-time';
import { shouldEmitEvent } from './_shared/should-emit-event';

const MSIT_PRESS_RSS_ENDPOINT = 'https://www.msit.go.kr/user/rss/rss.do?bbsSeqNo=94';
const REQUEST_TIMEOUT_MS = 60000;
const STATE_TTL_MS = 1000 * 60 * 60 * 24;
const EVENT_MAX_AGE_MS = STATE_TTL_MS * 0.9;

const REQUIRED_KEYWORD = '경보';
const ACTION_KEYWORDS = ['발령', '상향', '하향', '격상'] as const;

type MsitPressItem = {
  id: string;
  title: string;
  link: string;
  occurredAt: string | null;
  rawDate: string | null;
};

type MsitPressState = {
  seen: Record<string, string>;
};

type MsitPressLabelClassifier = Pick<LlmLabelClassifierService, 'isEnabled' | 'classifyBatch'>;

export class MsitPressReleaseSource implements Source {
  public readonly sourceId = EventSources.MsitPressRelease;
  public readonly pollIntervalSec = 60 * 10;

  constructor(private readonly labelClassifier: MsitPressLabelClassifier) {}

  public async run(state: string | null): Promise<SourceRunResult> {
    const previousState = parseState(state);
    const seen = new Map<string, string>(Object.entries(previousState.seen));
    const now = new Date();
    const nowMs = now.getTime();
    const nowIso = now.toISOString();

    const response = await fetchWithTimeout({
      url: MSIT_PRESS_RSS_ENDPOINT,
      timeoutMs: REQUEST_TIMEOUT_MS,
    });
    if (!response) {
      throw new Error('MSIT press release RSS request failed');
    }

    const xml = await response.text();
    const items = filterAlertItems(parseRssItems(xml, now));
    const resolvedKinds = await resolveDisasterKinds(items, this.labelClassifier);

    const events: SourceEvent[] = [];
    for (const item of items) {
      if (isTooOld(item.occurredAt, nowMs, EVENT_MAX_AGE_MS)) {
        continue;
      }

      if (!shouldEmitEvent(seen.get(item.id), nowMs, STATE_TTL_MS)) {
        seen.set(item.id, nowIso);
        continue;
      }

      const kind = resolvedKinds.get(item.id) ?? EventKinds.Other;
      events.push(buildEvent(item, kind));
      seen.set(item.id, nowIso);
    }

    pruneTimedMap(seen, nowMs, STATE_TTL_MS);
    const nextState = buildState(seen);

    return { events, nextState };
  }
}

function buildEvent(item: MsitPressItem, kind: EventKinds): SourceEvent {
  return {
    kind,
    title: item.title,
    body: null,
    occurredAt: item.occurredAt,
    regionText: null,
    level: mapCrisisLevel(item.title),
    payload: buildPayload(item),
  };
}

function buildPayload(item: MsitPressItem): EventPayload {
  return {
    nttSeqNo: item.id,
    link: item.link,
    publishedAt: item.rawDate,
  };
}

function filterAlertItems(items: MsitPressItem[]): MsitPressItem[] {
  const filtered: MsitPressItem[] = [];
  for (const item of items) {
    if (!item.title.includes(REQUIRED_KEYWORD)) {
      continue;
    }
    if (!hasActionKeyword(item.title)) {
      continue;
    }
    filtered.push(item);
  }
  return filtered;
}

function hasActionKeyword(title: string): boolean {
  for (const keyword of ACTION_KEYWORDS) {
    if (title.includes(keyword)) {
      return true;
    }
  }
  return false;
}

function parseRssItems(xml: string, now: Date): MsitPressItem[] {
  const $ = load(xml, { xmlMode: true });
  const nodes = $('item').toArray();
  if (nodes.length === 0) {
    logger.warn('Failed to find MSIT press release RSS items');
  }

  const items: MsitPressItem[] = [];
  for (const node of nodes) {
    const title = normalizeText($(node).find('title').first().text());
    const link = normalizeText($(node).find('link').first().text());
    if (!title || !link) {
      continue;
    }

    const id = extractNttSeqNo(link);
    if (!id) {
      logger.warn({ link, title }, 'Failed to extract MSIT press release nttSeqNo');
      continue;
    }

    const rawDate = normalizeText($(node).find('pubDate').first().text());
    const occurredAt = parseMsitDate(rawDate, now);
    if (rawDate && !occurredAt) {
      logger.warn({ rawDate, title }, 'Failed to parse MSIT press release pubDate');
    }

    items.push({
      id,
      title,
      link,
      occurredAt,
      rawDate,
    });
  }

  return items;
}

async function resolveDisasterKinds(
  items: MsitPressItem[],
  labelClassifier: MsitPressLabelClassifier,
): Promise<Map<string, EventKinds>> {
  const resolved = new Map<string, EventKinds>();
  const pending: Array<{ id: string; text: string }> = [];
  const isClassifierEnabled = labelClassifier.isEnabled();

  for (const item of items) {
    const directKind = findDirectKind(item.title);
    if (directKind) {
      resolved.set(item.id, directKind);
      continue;
    }

    if (!isClassifierEnabled) {
      resolved.set(item.id, EventKinds.Other);
      continue;
    }

    const text = item.title.trim();
    if (!text) {
      resolved.set(item.id, EventKinds.Other);
      continue;
    }

    pending.push({ id: item.id, text });
  }

  if (!isClassifierEnabled || pending.length === 0) {
    return resolved;
  }

  const batchItems: Array<{ id: string; text: string }> = [];
  for (const item of pending) {
    batchItems.push({ id: item.id, text: item.text });
  }

  let classified: Map<string, string> | null = null;
  try {
    classified = await labelClassifier.classifyBatch({
      labels: DISASTER_KIND_LABELS,
      items: batchItems,
      request:
        'Prefer labels that describe a CONFIRMED event over labels that describe risk, prevention, guidance, or general context.',
    });
  } catch (error) {
    logger.warn({ error, pendingCount: pending.length }, 'MSIT kind classification failed, fallback to other');
  }

  for (const item of pending) {
    const label = classified?.get(item.id) ?? '기타';
    resolved.set(item.id, DISASTER_KIND_BY_NAME[label] ?? EventKinds.Other);
  }

  return resolved;
}

function findDirectKind(title: string): EventKinds | null {
  const compactTitle = compactLabelText(title);
  if (!compactTitle) {
    return null;
  }

  const entries = Object.entries(DISASTER_KIND_BY_NAME);
  for (const [label, kind] of entries) {
    if (label === '기타') {
      continue;
    }
    const compactLabel = compactLabelText(label);
    if (compactLabel && compactTitle.includes(compactLabel)) {
      return kind;
    }
  }

  return null;
}

function compactLabelText(value: string): string {
  return value.replace(/\s+/g, '');
}

function mapCrisisLevel(title: string): EventLevels {
  const candidates: Array<{ keyword: string; level: EventLevels }> = [
    { keyword: '심각', level: EventLevels.Severe },
    { keyword: '경계', level: EventLevels.Moderate },
    { keyword: '주의', level: EventLevels.Minor },
    { keyword: '관심', level: EventLevels.Info },
  ];

  let bestLevel = EventLevels.Info;
  let bestIndex = -1;

  for (const candidate of candidates) {
    const index = title.lastIndexOf(candidate.keyword);
    if (index > bestIndex) {
      bestIndex = index;
      bestLevel = candidate.level;
    }
  }

  return bestIndex >= 0 ? bestLevel : EventLevels.Info;
}

function extractNttSeqNo(link: string | null): string | null {
  if (!link) {
    return null;
  }

  const trimmed = link.trim();
  try {
    const url = new URL(trimmed);
    const id = url.searchParams.get('nttSeqNo');
    if (id && id.trim().length > 0) {
      return id.trim();
    }
  } catch (error) {
    logger.debug({ error, link: trimmed }, 'Failed to parse MSIT press release link as URL');
  }

  const matched = trimmed.match(/[?&]nttSeqNo=(\d+)/);
  return matched ? matched[1] : null;
}

function parseMsitDate(value: string | null, now: Date): string | null {
  if (!value) {
    return null;
  }

  const trimmed = value.trim();
  const matched = trimmed.match(/^(\d{4})\.(\d{2})\.(\d{2})/);
  if (!matched) {
    return null;
  }

  const [, year, month, day] = matched;
  const yearNum = Number(year);
  const monthNum = Number(month);
  const dayNum = Number(day);
  if (!Number.isFinite(yearNum) || !Number.isFinite(monthNum) || !Number.isFinite(dayNum)) {
    return null;
  }

  return resolveDateOnlyWithServerTime({ year: yearNum, month: monthNum, day: dayNum }, now);
}

function parseState(state: string | null): MsitPressState {
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
    logger.warn({ error }, 'Failed to parse MSIT press release checkpoint state');
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
