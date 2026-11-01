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

const NCTC_TERROR_ALERT_LIST_ENDPOINT =
  'http://www.nctc.go.kr/base/board/list?boardManagementNo=20&menuLevel=3&menuNo=4';
const REQUEST_TIMEOUT_MS = 15000;
const STATE_TTL_MS = 1000 * 60 * 60 * 24 * 3;
const EVENT_MAX_AGE_MS = STATE_TTL_MS;
const ALERT_STAGE_BY_LABEL: Record<string, number> = { 관심: 1, 주의: 2, 경계: 3, 심각: 4 };

type AlertChange = 'raise' | 'lower' | null;
type AlertLevelInfo = {
  stage: number | null;
  label: string | null;
  previousStage: number | null;
  change: AlertChange;
};
type NctcAlertRow = {
  id: string;
  title: string;
  registeredAt: string;
  registeredAtIso: string;
  detailUrl: string;
};
type NctcAlertState = { seen: Record<string, string> };

export class NctcTerrorAlertSource implements Source {
  public readonly sourceId = EventSources.NctcTerrorAlert;
  public readonly pollIntervalSec = 60 * 10;

  public async run(state: string | null): Promise<SourceRunResult> {
    const previousState = parseState(state);
    const seen = new Map<string, string>(Object.entries(previousState.seen));
    const now = new Date();
    const nowMs = now.getTime();
    const nowIso = now.toISOString();
    const response = await fetchWithTimeout({ url: NCTC_TERROR_ALERT_LIST_ENDPOINT, timeoutMs: REQUEST_TIMEOUT_MS });
    if (!response) {
      throw new Error('NCTC terror alert list request failed');
    }

    const rows = parseRows(await response.text(), now);
    const events: SourceEvent[] = [];
    for (const row of rows) {
      if (isTooOld(row.registeredAtIso, nowMs, EVENT_MAX_AGE_MS)) {
        continue;
      }
      if (shouldEmitEvent(seen.get(row.id), nowMs, STATE_TTL_MS)) {
        events.push(buildEvent(row));
      }
      seen.set(row.id, nowIso);
    }
    pruneTimedMap(seen, nowMs, STATE_TTL_MS);
    return { events, nextState: buildState(seen) };
  }
}

function buildEvent(row: NctcAlertRow): SourceEvent {
  const level = parseAlertLevel(row.title);
  return {
    kind: EventKinds.Terror,
    title: row.title,
    body: null,
    // 게시판 등록일은 실제 발령일이 아니므로 발생 시각으로 사용하지 않는다.
    occurredAt: null,
    regionText: null,
    level: mapAlertLevel(level.stage),
    payload: {
      alertId: row.id,
      stage: level.stage,
      stageLabel: level.label,
      stageRaw: row.title,
      previousStage: level.previousStage,
      change: level.change,
      registeredAt: row.registeredAt,
      issuedAt: null,
      issuedAtIso: null,
      closedAt: null,
      regionText: null,
      detailUrl: row.detailUrl,
      listTitle: row.title,
    },
  };
}

function mapAlertLevel(stage: number | null): EventLevels {
  if (stage === 4) {
    return EventLevels.Severe;
  }
  if (stage === 3) {
    return EventLevels.Moderate;
  }
  if (stage === 2) {
    return EventLevels.Minor;
  }
  return EventLevels.Info;
}

function parseRows(html: string, now: Date): NctcAlertRow[] {
  const $ = load(html);
  const table = $('table.board_list').first();
  const headings = table
    .find('thead th')
    .toArray()
    .map((cell) => normalizeText($(cell).text()));
  if (table.length === 0 || headings.join('|') !== '구분|제목|첨부파일|등록일|조회수') {
    throw new Error('Failed to find NCTC terror alert table');
  }
  const elements = table.find('tbody > tr').toArray();
  if (elements.length === 0) {
    throw new Error('NCTC terror alert table has no rows');
  }
  const rows: NctcAlertRow[] = [];
  for (const element of elements) {
    const cells = $(element).children('td');
    const titleLink = cells.eq(1).find('a').first();
    const title = normalizeText(titleLink.text());
    const registeredAt = normalizeText(cells.eq(3).text());
    const registeredAtIso = registeredAt ? parseKstDate(registeredAt, now) : null;
    const detailUrl = buildDetailUrl(titleLink.attr('href'));
    if (cells.length !== 5 || !title || !registeredAt || !registeredAtIso || !detailUrl) {
      throw new Error('Failed to parse NCTC terror alert row');
    }
    rows.push({
      id: detailUrl.searchParams.get('boardNo') ?? '',
      title,
      registeredAt,
      registeredAtIso,
      detailUrl: detailUrl.toString(),
    });
  }
  return rows;
}

function parseAlertLevel(title: string): AlertLevelInfo {
  const labels = title.match(/관심|주의|경계|심각/g) ?? [];
  const change: AlertChange = title.includes('상향') ? 'raise' : /하향|환원/.test(title) ? 'lower' : null;
  if (labels.length === 0 || labels.length > 2) {
    return { stage: null, label: null, previousStage: null, change };
  }

  // 공고 제목에 두 단계가 나오면 앞이 이전 단계, 뒤가 조정 후 단계다.
  const label = labels[labels.length - 1];
  return {
    stage: ALERT_STAGE_BY_LABEL[label],
    label,
    previousStage: labels.length === 2 ? ALERT_STAGE_BY_LABEL[labels[0]] : null,
    change,
  };
}

function buildDetailUrl(href: string | undefined): URL | null {
  if (!href) {
    return null;
  }
  try {
    const url = new URL(href, NCTC_TERROR_ALERT_LIST_ENDPOINT);
    if (
      url.origin !== new URL(NCTC_TERROR_ALERT_LIST_ENDPOINT).origin ||
      url.pathname !== '/base/board/read' ||
      url.searchParams.get('boardManagementNo') !== '20' ||
      !/^\d+$/.test(url.searchParams.get('boardNo') ?? '')
    ) {
      return null;
    }
    return url;
  } catch {
    return null;
  }
}

function parseState(state: string | null): NctcAlertState {
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
    logger.warn({ error }, 'Failed to parse NCTC terror alert checkpoint state');
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

function parseKstDate(value: string, now: Date): string | null {
  const match = value.match(/^(\d{4})[./-](\d{2})[./-](\d{2})$/);
  if (!match) {
    return null;
  }
  const [, yearText, monthText, dayText] = match;
  const year = Number(yearText),
    month = Number(monthText),
    day = Number(dayText);
  const date = new Date(Date.UTC(year, month - 1, day));
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) {
    return null;
  }
  return resolveDateOnlyWithServerTime({ year, month, day }, now);
}
