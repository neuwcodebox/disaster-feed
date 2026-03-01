import { load } from 'cheerio';
import { logger } from '@/core/logger';
import { EventKinds, EventLevels, EventSources } from '@/modules/events/domain/event.enums';
import type { Source, SourceEvent, SourceRunResult } from '../../domain/port/source.interface';
import { fetchWithTimeout } from './_shared/fetch-with-timeout';
import { isTooOld } from './_shared/is-too-old';
import { normalizeText } from './_shared/normalize';
import { pruneTimedMap } from './_shared/prune-timed-map';
import { resolveDateOnlyWithServerTime } from './_shared/resolve-date-only-with-server-time';
import { shouldEmitEvent } from './_shared/should-emit-event';

const KDCA_PRESS_RSS_ENDPOINT = 'https://www.kdca.go.kr/bbs/kdca/41/rssList.do?row=10';
const KDCA_BASE_URL = 'https://www.kdca.go.kr';
const REQUEST_TIMEOUT_MS = 15000;
const STATE_TTL_MS = 1000 * 60 * 60 * 24;
const EVENT_MAX_AGE_MS = STATE_TTL_MS * 0.9;

const REQUIRED_KEYWORD = '경보';
const ACTION_KEYWORDS = ['발령', '상향', '하향', '격상'] as const;

type KdcaPressItem = {
  id: string;
  title: string;
  link: string;
  author: string | null;
  description: string | null;
  occurredAt: string | null;
  rawDate: string | null;
};

type KdcaPressState = {
  seen: Record<string, string>;
};

export class KdcaPressReleaseSource implements Source {
  public readonly sourceId = EventSources.KdcaPressRelease;
  public readonly pollIntervalSec = 60 * 10;

  public async run(state: string | null): Promise<SourceRunResult> {
    const previousState = parseState(state);
    const seen = new Map<string, string>(Object.entries(previousState.seen));
    const now = new Date();
    const nowMs = now.getTime();
    const nowIso = now.toISOString();

    const response = await fetchWithTimeout({
      url: KDCA_PRESS_RSS_ENDPOINT,
      timeoutMs: REQUEST_TIMEOUT_MS,
    });
    if (!response) {
      throw new Error('KDCA press release RSS request failed');
    }

    const xml = await response.text();
    const items = filterAlertItems(parseRssItems(xml, now));

    const events: SourceEvent[] = [];
    for (const item of items) {
      if (isTooOld(item.occurredAt, nowMs, EVENT_MAX_AGE_MS)) {
        continue;
      }

      if (!shouldEmitEvent(seen.get(item.id), nowMs, STATE_TTL_MS)) {
        seen.set(item.id, nowIso);
        continue;
      }

      events.push(buildEvent(item));
      seen.set(item.id, nowIso);
    }

    pruneTimedMap(seen, nowMs, STATE_TTL_MS);
    const nextState = buildState(seen);

    return { events, nextState };
  }
}

function buildEvent(item: KdcaPressItem): SourceEvent {
  return {
    kind: EventKinds.Epidemic,
    title: item.title,
    body: item.description,
    occurredAt: item.occurredAt,
    level: mapCrisisLevel(item.title),
    payload: item,
  };
}

function filterAlertItems(items: KdcaPressItem[]): KdcaPressItem[] {
  const filtered: KdcaPressItem[] = [];
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

function parseRssItems(xml: string, now: Date): KdcaPressItem[] {
  const $ = load(xml, { xmlMode: true });
  const nodes = $('item').toArray();
  if (nodes.length === 0) {
    logger.warn('Failed to find KDCA press release RSS items');
  }

  const items: KdcaPressItem[] = [];
  for (const node of nodes) {
    const title = normalizeText($(node).find('title').first().text());
    const rawLink = normalizeText($(node).find('link').first().text());
    if (!title || !rawLink) {
      continue;
    }

    const link = resolveLink(rawLink);
    const id = extractArticleId(link) ?? title;
    if (!id) {
      logger.warn({ link, title }, 'Failed to resolve KDCA press release id');
      continue;
    }
    if (id === title) {
      logger.warn({ link, title }, 'Using title as KDCA press release id fallback');
    }

    const author = normalizeText($(node).find('author').first().text());
    const description = normalizeText($(node).find('description').first().text());
    const rawDate = normalizeText($(node).find('pubDate').first().text());
    const occurredAt = parseKdcaDate(rawDate, now);
    if (rawDate && !occurredAt) {
      logger.warn({ rawDate, title }, 'Failed to parse KDCA press release pubDate');
    }

    items.push({
      id,
      title,
      link,
      author,
      description,
      occurredAt,
      rawDate,
    });
  }

  return items;
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

function resolveLink(value: string): string {
  const trimmed = value.trim();
  try {
    return new URL(trimmed, KDCA_BASE_URL).toString();
  } catch (error) {
    logger.debug({ error, link: trimmed }, 'Failed to resolve KDCA press release link');
    return trimmed;
  }
}

function extractArticleId(link: string | null): string | null {
  if (!link) {
    return null;
  }

  const trimmed = link.trim();
  try {
    const url = new URL(trimmed, KDCA_BASE_URL);
    const matched = url.pathname.match(/\/bbs\/kdca\/41\/(\d+)/);
    if (matched) {
      return matched[1];
    }
  } catch (error) {
    logger.debug({ error, link: trimmed }, 'Failed to parse KDCA press release link as URL');
  }

  const fallback = trimmed.match(/\/bbs\/kdca\/41\/(\d+)/);
  return fallback ? fallback[1] : null;
}

function parseKdcaDate(value: string | null, now: Date): string | null {
  if (!value) {
    return null;
  }

  const trimmed = value.trim();
  const dateTimeMatch = trimmed.match(/^(\d{4})-(\d{2})-(\d{2})\s+(\d{2}):(\d{2}):(\d{2})/);
  if (dateTimeMatch) {
    const [, year, month, day, hour, minute, second] = dateTimeMatch;
    const kstIso = `${year}-${month}-${day}T${hour}:${minute}:${second}+09:00`;
    const parsed = new Date(kstIso);
    if (!Number.isNaN(parsed.getTime())) {
      return parsed.toISOString();
    }
  }

  const dateOnlyMatch = trimmed.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!dateOnlyMatch) {
    return null;
  }

  const [, year, month, day] = dateOnlyMatch;
  const yearNum = Number(year);
  const monthNum = Number(month);
  const dayNum = Number(day);
  if (!Number.isFinite(yearNum) || !Number.isFinite(monthNum) || !Number.isFinite(dayNum)) {
    return null;
  }

  return resolveDateOnlyWithServerTime({ year: yearNum, month: monthNum, day: dayNum }, now);
}

function parseState(state: string | null): KdcaPressState {
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
    logger.warn({ error }, 'Failed to parse KDCA press release checkpoint state');
    return { seen: {} };
  }
}

function buildState(seen: Map<string, string>): string {
  const payload: Record<string, string> = {};
  for (const [key, value] of seen) {
    payload[key] = value;
  }

  return JSON.stringify({ seen: payload });
}
