import { type Cheerio, load } from 'cheerio';
import type { AnyNode } from 'domhandler';
import { z } from 'zod';
import { logger } from '@/core/logger';
import type { EventPayload } from '@/modules/events/domain/entity/event.entity';
import { EventKinds, EventLevels, EventSources } from '@/modules/events/domain/event.enums';
import type { Source, SourceEvent, SourceRunResult } from '../../domain/port/source.interface';
import { fetchWithTimeout } from './_shared/fetch-with-timeout';
import { isTooOld } from './_shared/is-too-old';
import { normalizeText } from './_shared/normalize';
import { pruneTimedMap } from './_shared/prune-timed-map';
import { resolveDateOnlyWithServerTime } from './_shared/resolve-date-only-with-server-time';
import { shouldEmitEvent } from './_shared/should-emit-event';

const NCTC_TERROR_ALERT_LIST_ENDPOINT =
  'http://www.nctc.go.kr/nctc/information/alertIssuanceStatus.do?mode=list&articleLimit=10&article.offset=0';
const NCTC_TERROR_ALERT_VIEW_BASE = 'http://www.nctc.go.kr/nctc/information/alertIssuanceStatus.do';
const TABLE_SELECTOR = '#real-content table';
const DETAIL_TITLE_SELECTOR = 'dd.view-tit';
const DETAIL_BODY_SELECTOR = '#real-content dl.board-write-box.board-write-box-v03 > dd';
const REQUEST_TIMEOUT_MS = 15000;
const STATE_TTL_MS = 1000 * 60 * 60 * 24 * 3;
const EVENT_MAX_AGE_MS = STATE_TTL_MS;
const ALERT_LABEL_BY_STAGE: Record<number, string> = {
  1: '관심',
  2: '주의',
  3: '경계',
  4: '심각',
};

const schemaNctcAlertRow = z.object({
  id: z.string().min(1),
  title: z.string().min(1),
  issuedAt: z.string().min(1),
  closedAt: z.string().nullable(),
  regionText: z.string().nullable(),
  detailUrl: z.string().min(1).nullable(),
  levelStage: z.number().int().min(1).max(4).nullable(),
  levelLabel: z.string().nullable(),
  levelRaw: z.string().nullable(),
});

type NctcAlertRow = z.infer<typeof schemaNctcAlertRow>;

type NctcAlertState = {
  seen: Record<string, string>;
};

type NctcAlertDetail = {
  title: string | null;
  body: string | null;
};

type AlertLevelInfo = {
  stage: number | null;
  label: string | null;
  raw: string | null;
};

export class NctcTerrorAlertSource implements Source {
  public readonly sourceId = EventSources.NctcTerrorAlert;
  public readonly pollIntervalSec = 60 * 10;

  public async run(state: string | null): Promise<SourceRunResult> {
    const previousState = parseState(state);
    const seen = new Map<string, string>(Object.entries(previousState.seen));
    const now = new Date();
    const nowMs = now.getTime();
    const nowIso = now.toISOString();

    const response = await fetchWithTimeout({
      url: NCTC_TERROR_ALERT_LIST_ENDPOINT,
      timeoutMs: REQUEST_TIMEOUT_MS,
    });
    if (!response) {
      throw new Error('NCTC terror alert list request failed');
    }

    const html = await response.text();
    const rows = parseRows(html);

    const events: SourceEvent[] = [];
    for (const row of rows) {
      const occurredAt = parseKstDate(row.issuedAt, now);
      if (isTooOld(occurredAt, nowMs, EVENT_MAX_AGE_MS)) {
        continue;
      }

      if (!shouldEmitEvent(seen.get(row.id), nowMs, STATE_TTL_MS)) {
        seen.set(row.id, nowIso);
        continue;
      }

      const detail = await fetchDetail(row.detailUrl);
      const title = detail?.title ?? row.title;
      const body = detail?.body ?? buildFallbackBody(row);

      events.push(buildEvent(row, occurredAt, title, body, detail));
      seen.set(row.id, nowIso);
    }

    pruneTimedMap(seen, nowMs, STATE_TTL_MS);
    const nextState = buildState(seen);

    return { events, nextState };
  }
}

function buildEvent(
  row: NctcAlertRow,
  occurredAt: string | null,
  title: string,
  body: string | null,
  detail: NctcAlertDetail | null,
): SourceEvent {
  return {
    kind: EventKinds.Terror,
    title,
    body,
    occurredAt,
    regionText: row.regionText,
    level: mapAlertLevel(row.levelStage, row.levelLabel),
    payload: buildPayload(row, occurredAt, detail),
  };
}

function buildPayload(row: NctcAlertRow, occurredAt: string | null, detail: NctcAlertDetail | null): EventPayload {
  return {
    alertId: row.id,
    stage: row.levelStage,
    stageLabel: row.levelLabel,
    stageRaw: row.levelRaw,
    issuedAt: row.issuedAt,
    issuedAtIso: occurredAt,
    closedAt: row.closedAt,
    regionText: row.regionText,
    detailUrl: row.detailUrl,
    listTitle: row.title,
    detailTitle: detail?.title ?? null,
  };
}

function buildFallbackBody(row: NctcAlertRow): string | null {
  const stage = row.levelLabel ?? (row.levelStage ? ALERT_LABEL_BY_STAGE[row.levelStage] : null);
  const parts = [
    stage ? `단계: ${stage}` : null,
    row.issuedAt ? `발령일: ${row.issuedAt}` : null,
    row.regionText ? `지역: ${row.regionText}` : null,
  ].filter((value): value is string => Boolean(value));

  return parts.length > 0 ? parts.join('\n') : null;
}

function mapAlertLevel(stage: number | null, label: string | null): EventLevels {
  if (stage === 4 || label?.includes('심각')) {
    return EventLevels.Severe;
  }
  if (stage === 3 || label?.includes('경계')) {
    return EventLevels.Moderate;
  }
  if (stage === 2 || label?.includes('주의')) {
    return EventLevels.Minor;
  }
  if (stage === 1 || label?.includes('관심')) {
    return EventLevels.Info;
  }
  return EventLevels.Info;
}

function parseRows(html: string): NctcAlertRow[] {
  const $ = load(html);
  const table = $(TABLE_SELECTOR).first();
  if (table.length === 0) {
    logger.warn('Failed to find NCTC terror alert table');
    throw new Error('Failed to find NCTC terror alert table');
  }

  const rows: NctcAlertRow[] = [];
  const elements = table.find('tr').toArray();

  for (const element of elements) {
    const cells = $(element).find('td').toArray();
    if (cells.length < 6) {
      continue;
    }

    const id = normalizeText($(cells[0]).text()) ?? '';
    const titleCell = $(cells[1]);
    const title = normalizeText(titleCell.text()) ?? '';
    const detailUrl = buildDetailUrl(titleCell.find('a').attr('href'));
    const levelInfo = parseAlertLevel($(cells[2]));
    const issuedAt = normalizeText($(cells[3]).text()) ?? '';
    const closedAt = normalizeText($(cells[4]).text());
    const regionText = normalizeText($(cells[5]).text());

    const row = {
      id,
      title,
      issuedAt,
      closedAt,
      regionText,
      detailUrl,
      levelStage: levelInfo.stage,
      levelLabel: levelInfo.label,
      levelRaw: levelInfo.raw,
    };

    const parsed = schemaNctcAlertRow.safeParse(row);
    if (!parsed.success) {
      logger.warn({ error: parsed.error }, 'Failed to parse NCTC terror alert row');
      continue;
    }

    rows.push(parsed.data);
  }

  return rows;
}

function parseAlertLevel(cell: Cheerio<AnyNode>): AlertLevelInfo {
  const image = cell.find('img').first();
  const alt = normalizeText(image.attr('alt'));
  const src = normalizeText(image.attr('src'));
  const text = normalizeText(cell.text());
  const raw = alt ?? text;

  const stage = parseStageFromText(alt) ?? parseStageFromText(text) ?? parseStageFromSrc(src);
  const label = parseLabelFromText(alt) ?? parseLabelFromText(text) ?? (stage ? ALERT_LABEL_BY_STAGE[stage] : null);

  return { stage, label, raw };
}

function parseStageFromText(value: string | null): number | null {
  const normalized = normalizeText(value);
  if (!normalized) {
    return null;
  }

  const matchIn = normalized.match(/중\s*([1-4])\s*단계/);
  if (matchIn) {
    return Number(matchIn[1]);
  }

  if (normalized.includes('관심')) {
    return 1;
  }
  if (normalized.includes('주의')) {
    return 2;
  }
  if (normalized.includes('경계')) {
    return 3;
  }
  if (normalized.includes('심각')) {
    return 4;
  }

  return null;
}

function parseStageFromSrc(value: string | null): number | null {
  const normalized = normalizeText(value);
  if (!normalized) {
    return null;
  }

  const matched = normalized.match(/([1-4])\.(?:gif|png|jpg)$/i);
  if (!matched) {
    return null;
  }

  return Number(matched[1]);
}

function parseLabelFromText(value: string | null): string | null {
  const normalized = normalizeText(value);
  if (!normalized) {
    return null;
  }

  if (normalized.includes('관심')) {
    return '관심';
  }
  if (normalized.includes('주의')) {
    return '주의';
  }
  if (normalized.includes('경계')) {
    return '경계';
  }
  if (normalized.includes('심각')) {
    return '심각';
  }

  return null;
}

function buildDetailUrl(href: string | undefined): string | null {
  const normalized = normalizeText(href);
  if (!normalized) {
    return null;
  }

  try {
    return new URL(normalized, NCTC_TERROR_ALERT_VIEW_BASE).toString();
  } catch (error) {
    logger.warn({ error, href: normalized }, 'Failed to build NCTC terror alert detail URL');
    return null;
  }
}

async function fetchDetail(detailUrl: string | null): Promise<NctcAlertDetail | null> {
  if (!detailUrl) {
    return null;
  }

  const response = await fetchWithTimeout({
    url: detailUrl,
    timeoutMs: REQUEST_TIMEOUT_MS,
  });
  if (!response) {
    logger.warn({ detailUrl }, 'NCTC terror alert detail request failed');
    return null;
  }

  const html = await response.text();
  return parseDetail(html);
}

function parseDetail(html: string): NctcAlertDetail {
  const $ = load(html);
  const title = normalizeText($(DETAIL_TITLE_SELECTOR).first().text());
  const bodyElement = $(DETAIL_BODY_SELECTOR).first();
  const blocks = bodyElement.find('> div').toArray();
  const blockTexts: string[] = [];
  for (const block of blocks) {
    const text = normalizeText($(block).text());
    if (text) {
      blockTexts.push(text);
    }
  }

  const body = blockTexts.length > 0 ? blockTexts.join('\n') : normalizeText(bodyElement.text());
  return { title, body };
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

function parseKstDate(value: string, now: Date): string | null {
  const normalized = normalizeText(value);
  if (!normalized) {
    return null;
  }

  const matched = normalized.match(/^(\d{4})[./-](\d{2})[./-](\d{2})$/);
  if (!matched) {
    return null;
  }

  const [, year, month, day] = matched;
  const yearNum = Number(year);
  const monthNum = Number(month);
  const dayNum = Number(day);
  return resolveDateOnlyWithServerTime({ year: yearNum, month: monthNum, day: dayNum }, now);
}
