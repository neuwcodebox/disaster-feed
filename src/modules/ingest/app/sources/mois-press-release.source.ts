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
import { shouldEmitEvent } from './_shared/should-emit-event';

const MOIS_PRESS_RSS_ENDPOINT = 'https://www.mois.go.kr/gpms/view/jsp/rss/rss.jsp?ctxCd=1012';
const REQUEST_TIMEOUT_MS = 15000;
const STATE_TTL_MS = 1000 * 60 * 60 * 24;
const EVENT_MAX_AGE_MS = STATE_TTL_MS * 0.9;
const CRISIS_KEYWORD = '위기경보';

const MONTH_BY_LABEL: Record<string, string> = {
  JAN: '01',
  FEB: '02',
  MAR: '03',
  APR: '04',
  MAY: '05',
  JUN: '06',
  JUL: '07',
  AUG: '08',
  SEP: '09',
  OCT: '10',
  NOV: '11',
  DEC: '12',
};

type MoisPressItem = {
  id: string;
  title: string;
  link: string;
  author: string | null;
  occurredAt: string | null;
  rawDate: string | null;
};

type MoisPressState = {
  seen: Record<string, string>;
};

type MoisPressLabelClassifier = Pick<LlmLabelClassifierService, 'isEnabled' | 'classifyBatch'>;

export class MoisPressReleaseSource implements Source {
  public readonly sourceId = EventSources.MoisPressRelease;
  public readonly pollIntervalSec = 60 * 10;

  constructor(private readonly labelClassifier: MoisPressLabelClassifier) {}

  public async run(state: string | null): Promise<SourceRunResult> {
    const previousState = parseState(state);
    const seen = new Map<string, string>(Object.entries(previousState.seen));
    const now = new Date();
    const nowMs = now.getTime();
    const nowIso = now.toISOString();

    const response = await fetchWithTimeout({
      url: MOIS_PRESS_RSS_ENDPOINT,
      timeoutMs: REQUEST_TIMEOUT_MS,
    });
    if (!response) {
      throw new Error('MOIS press release RSS request failed');
    }

    const xml = await response.text();
    const items = filterCrisisItems(parseRssItems(xml));
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

function buildEvent(item: MoisPressItem, kind: EventKinds): SourceEvent {
  return {
    kind,
    title: item.title,
    body: item.author,
    occurredAt: item.occurredAt,
    level: mapCrisisLevel(item.title),
    payload: buildPayload(item),
  };
}

function buildPayload(item: MoisPressItem): EventPayload {
  return {
    nttId: item.id,
    link: item.link,
    author: item.author,
    publishedAt: item.rawDate,
  };
}

function filterCrisisItems(items: MoisPressItem[]): MoisPressItem[] {
  const filtered: MoisPressItem[] = [];
  for (const item of items) {
    if (item.title.includes(CRISIS_KEYWORD)) {
      filtered.push(item);
    }
  }
  return filtered;
}

function parseRssItems(xml: string): MoisPressItem[] {
  const $ = load(xml, { xmlMode: true });
  const nodes = $('item').toArray();
  if (nodes.length === 0) {
    logger.warn('Failed to find MOIS press release RSS items');
  }

  const items: MoisPressItem[] = [];
  for (const node of nodes) {
    const title = normalizeText($(node).find('title').first().text());
    const link = normalizeText($(node).find('link').first().text());
    if (!title || !link) {
      continue;
    }

    const id = extractNttId(link);
    if (!id) {
      logger.warn({ link, title }, 'Failed to extract MOIS press release nttId');
      continue;
    }

    const author = normalizeText($(node).find('author').first().text());
    const rawDate = normalizeText($(node).find('pubDate').first().text());
    const occurredAt = parseRssPubDate(rawDate);
    if (rawDate && !occurredAt) {
      logger.warn({ rawDate, title }, 'Failed to parse MOIS press release pubDate');
    }

    items.push({
      id,
      title,
      link,
      author,
      occurredAt,
      rawDate,
    });
  }

  return items;
}

async function resolveDisasterKinds(
  items: MoisPressItem[],
  labelClassifier: MoisPressLabelClassifier,
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
    });
  } catch (error) {
    logger.warn({ error, pendingCount: pending.length }, 'MOIS kind classification failed, fallback to other');
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

function extractNttId(link: string | null): string | null {
  if (!link) {
    return null;
  }

  const trimmed = link.trim();
  try {
    const url = new URL(trimmed);
    const id = url.searchParams.get('nttId');
    if (id && id.trim().length > 0) {
      return id.trim();
    }
  } catch (error) {
    logger.debug({ error, link: trimmed }, 'Failed to parse MOIS press release link as URL');
  }

  const matched = trimmed.match(/[?&]nttId=(\d+)/);
  return matched ? matched[1] : null;
}

function parseRssPubDate(value: string | null): string | null {
  if (!value) {
    return null;
  }

  const normalized = value.trim();
  const replaced = normalized.replace(/\bKST\b/gi, '+09:00');
  const parsed = new Date(replaced);
  if (!Number.isNaN(parsed.getTime())) {
    return parsed.toISOString();
  }

  const matched = normalized.match(/^[A-Z]{3},\s*(\d{1,2})\s*([A-Z]{3})\s*(\d{4})\s*(\d{2}):(\d{2}):(\d{2})/i);
  if (!matched) {
    return null;
  }

  const [, day, monthText, year, hour, minute, second] = matched;
  const month = MONTH_BY_LABEL[monthText.toUpperCase()];
  if (!month) {
    return null;
  }

  const dayText = day.padStart(2, '0');
  const kstIso = `${year}-${month}-${dayText}T${hour}:${minute}:${second}+09:00`;
  const kstParsed = new Date(kstIso);
  if (Number.isNaN(kstParsed.getTime())) {
    return null;
  }

  return kstParsed.toISOString();
}

function parseState(state: string | null): MoisPressState {
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
    logger.warn({ error }, 'Failed to parse MOIS press release checkpoint state');
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
