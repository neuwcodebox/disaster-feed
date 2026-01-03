import { z } from 'zod';
import { env } from '@/core/env';
import { logger } from '@/core/logger';
import type { EventPayload } from '@/modules/events/domain/entity/event.entity';
import { EventKinds, EventLevels, EventSources } from '@/modules/events/domain/event.enums';
import { NonRetryError } from '@/modules/ingest/domain/ingest.errors';
import type { Source, SourceEvent, SourceRunResult } from '../../domain/port/source.interface';
import type { LlmLabelClassifierService } from '../llm-label-classifier.service';
import { DISASTER_KIND_BY_NAME, DISASTER_KIND_LABELS } from './_shared/disaster-kind-labels';
import { fetchWithTimeout } from './_shared/fetch-with-timeout';
import { normalizeText } from './_shared/normalize';
import { pruneTimedMap } from './_shared/prune-timed-map';
import { shouldEmitEvent } from './_shared/should-emit-event';

const YNA_NEWS_ENDPOINT = 'https://www.safetydata.go.kr/V2/api/DSSP-IF-00051';
const REQUEST_TIMEOUT_MS = 15000;
const PAGE_SIZE = 100;
const KST_OFFSET_MS = 9 * 60 * 60 * 1000;
const STATE_TTL_MS = 1000 * 60 * 60 * 24 * 2;

const schemaYnaNewsItem = z.object({
  CRT_DT: z.string().nullable().optional(),
  YNA_WRTR_NM: z.string().nullable().optional(),
  YNA_CN: z.string().nullable().optional(),
  YNA_YMD: z.string().nullable().optional(),
  YNA_TTL: z.string().nullable().optional(),
  YNA_NO: z.coerce.number().int(),
});

const schemaYnaNewsRawResponse = z.object({
  header: z.object({
    resultMsg: z.string().nullable().optional(),
    resultCode: z.string().nullable().optional(),
    errorMsg: z.string().nullable().optional(),
  }),
  numOfRows: z.coerce.number().int().nonnegative().optional(),
  pageNo: z.coerce.number().int().nonnegative().optional(),
  totalCount: z.coerce.number().int().nonnegative().optional(),
  body: z.array(schemaYnaNewsItem).nullable().optional(),
});

type YnaNewsItem = z.infer<typeof schemaYnaNewsItem>;
type YnaNewsRawResponse = z.infer<typeof schemaYnaNewsRawResponse>;
type YnaNewsResponse = {
  header: YnaNewsRawResponse['header'];
  numOfRows: number;
  pageNo: number;
  totalCount: number;
  body: YnaNewsItem[];
};

type YnaNewsState = {
  seen: Record<string, string>;
};

type ClassifiedNewsItem = {
  id: string;
  item: YnaNewsItem;
  text: string;
};

export class YnaNewsSource implements Source {
  public readonly sourceId = EventSources.YnaNews;
  public readonly pollIntervalSec = 60 * 3;

  constructor(private readonly labelClassifier: LlmLabelClassifierService) {}

  public async run(state: string | null): Promise<SourceRunResult> {
    const serviceKey = env.YNA_SERVICE_KEY;
    if (!serviceKey) {
      logger.error('YNA service key is missing');
      throw new Error('YNA service key is missing');
    }

    if (!this.labelClassifier.isEnabled()) {
      logger.error('LLM label classifier is not enabled');
      throw new Error('LLM label classifier is not enabled');
    }

    const inqDate = formatKstCompactDate(new Date());
    const previousState = parseState(state);
    const seen = new Map<string, string>(Object.entries(previousState.seen));
    const now = new Date();
    const nowIso = now.toISOString();
    const nowMs = now.getTime();

    const items = await this.fetchAllPages(serviceKey, inqDate);
    const uniqueItems = dedupeItems(items);

    const candidates: YnaNewsItem[] = [];
    for (const item of uniqueItems) {
      const key = buildItemKey(item);
      if (shouldEmitEvent(seen.get(key), nowMs, STATE_TTL_MS)) {
        candidates.push(item);
      }
    }

    const classifiedItems = buildClassifiedItems(candidates);
    if (classifiedItems.length === 0) {
      applySeen(seen, uniqueItems, nowIso);
      pruneTimedMap(seen, nowMs, STATE_TTL_MS);
      const nextState = buildState(seen);
      return { events: [], nextState };
    }

    const batchItems: Array<{ id: string; text: string }> = [];
    for (const entry of classifiedItems) {
      batchItems.push({ id: entry.id, text: entry.text });
    }

    const classified = await this.labelClassifier.classifyBatch({
      labels: DISASTER_KIND_LABELS,
      items: batchItems,
      request: [
        'Classify as a disaster category ONLY if the message reports a concrete incident, malfunction, or hazard that is currently occurring or has just occurred and causes direct harm, disruption, or emergency response affecting public safety or daily life.',
        'If the message is about investigations, legal or administrative processes, policy, technology adoption, system improvement, or routine management WITHOUT an active failure, outage, contamination, restriction, or emergency action, ALWAYS classify it as "기타".',
        'Keywords alone (e.g. death, accident, fire, collapse, or infrastructure terms like water or traffic) do NOT indicate an active disaster.',
      ].join('\n'),
    });

    if (!classified) {
      logger.error('LLM label classification failed');
      throw new Error('LLM label classification failed');
    }

    const events: SourceEvent[] = [];
    for (const entry of classifiedItems) {
      const label = classified.get(entry.id) ?? '기타';
      const kind = DISASTER_KIND_BY_NAME[label] ?? EventKinds.Other;
      if (kind === EventKinds.Other) {
        continue;
      }

      const event = this.buildEvent(entry.item, kind);
      if (event) {
        events.push(event);
      }
    }

    applySeen(seen, uniqueItems, nowIso);

    pruneTimedMap(seen, nowMs, STATE_TTL_MS);
    const nextState = buildState(seen);

    return { events, nextState };
  }

  private async fetchAllPages(serviceKey: string, inqDate: string): Promise<YnaNewsItem[]> {
    const items: YnaNewsItem[] = [];
    let pageNo = 1;
    let numOfRows = PAGE_SIZE;
    let totalPages = 1;

    while (pageNo <= totalPages) {
      const parsed = await this.fetchPage(serviceKey, inqDate, pageNo, numOfRows);

      if (pageNo === 1) {
        numOfRows = parsed.numOfRows > 0 ? parsed.numOfRows : numOfRows;
        totalPages = numOfRows > 0 ? Math.ceil(parsed.totalCount / numOfRows) : 0;
      }

      for (const item of parsed.body) {
        items.push(item);
      }

      if (totalPages === 0) {
        break;
      }

      pageNo += 1;
    }

    return items;
  }

  private async fetchPage(
    serviceKey: string,
    inqDate: string,
    pageNo: number,
    numOfRows: number,
  ): Promise<YnaNewsResponse> {
    const response = await fetchWithTimeout({
      url: this.buildRequestUrl(serviceKey, inqDate, pageNo, numOfRows),
      timeoutMs: REQUEST_TIMEOUT_MS,
    });

    if (!response) {
      throw new Error(`YNA news request failed: page ${pageNo}`);
    }

    const data = await response.json();
    const parsed = schemaYnaNewsRawResponse.safeParse(data);
    if (!parsed.success) {
      logger.warn({ error: parsed.error }, 'Failed to parse YNA news response');
      throw new Error('Failed to parse YNA news response');
    }

    const header = parsed.data.header;
    if (header.resultCode && header.resultCode !== '00') {
      logger.warn({ header }, 'YNA news response error');
      if (header.resultCode === '22') {
        throw new NonRetryError('YNA news response error: resultCode=22');
      }
      throw new Error('YNA news response error');
    }

    return normalizeResponse(parsed.data);
  }

  private buildRequestUrl(serviceKey: string, inqDate: string, pageNo: number, numOfRows: number): string {
    const url = new URL(YNA_NEWS_ENDPOINT);
    const params = new URLSearchParams({
      serviceKey: normalizeServiceKey(serviceKey),
      pageNo: String(pageNo),
      numOfRows: String(numOfRows),
      returnType: 'json',
      inqDt: inqDate,
    });
    url.search = params.toString();
    return url.toString();
  }

  private buildEvent(item: YnaNewsItem, kind: EventKinds): SourceEvent | null {
    const title = normalizeText(item.YNA_TTL);
    if (!title) {
      return null;
    }

    return {
      kind,
      title,
      body: null,
      occurredAt: parseKstDateTime(item.YNA_YMD),
      regionText: null,
      level: EventLevels.Info,
      payload: this.buildPayload(item),
    };
  }

  private buildPayload(item: YnaNewsItem): EventPayload {
    return {
      newsId: item.YNA_NO,
      content: normalizeText(item.YNA_CN),
      createdAt: normalizeText(item.CRT_DT),
      occurredAt: normalizeText(item.YNA_YMD),
    };
  }
}

function normalizeResponse(raw: YnaNewsRawResponse): YnaNewsResponse {
  return {
    header: raw.header,
    numOfRows: raw.numOfRows ?? 0,
    pageNo: raw.pageNo ?? 0,
    totalCount: raw.totalCount ?? 0,
    body: raw.body ?? [],
  };
}

function parseState(state: string | null): YnaNewsState {
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
    for (const [key, value] of Object.entries(rawSeen)) {
      if (typeof value === 'string') {
        seen[key] = value;
      }
    }

    return { seen };
  } catch (error) {
    logger.warn({ error }, 'Failed to parse YNA news checkpoint state');
    return { seen: {} };
  }
}

function buildState(seen: Map<string, string>): string | null {
  if (seen.size === 0) {
    return null;
  }

  return JSON.stringify({ seen: Object.fromEntries(seen) });
}

function dedupeItems(items: YnaNewsItem[]): YnaNewsItem[] {
  const byId = new Map<number, YnaNewsItem>();
  for (const item of items) {
    if (!byId.has(item.YNA_NO)) {
      byId.set(item.YNA_NO, item);
    }
  }
  return Array.from(byId.values());
}

function buildItemKey(item: YnaNewsItem): string {
  return String(item.YNA_NO);
}

function applySeen(seen: Map<string, string>, items: YnaNewsItem[], seenAt: string): void {
  for (const item of items) {
    seen.set(buildItemKey(item), seenAt);
  }
}

function buildClassifiedItems(items: YnaNewsItem[]): ClassifiedNewsItem[] {
  const result: ClassifiedNewsItem[] = [];
  for (const item of items) {
    const text = buildClassifyText(item);
    if (!text) {
      continue;
    }
    result.push({
      id: String(item.YNA_NO),
      item,
      text,
    });
  }
  return result;
}

function buildClassifyText(item: YnaNewsItem): string | null {
  const title = normalizeText(item.YNA_TTL);
  const content = normalizeText(item.YNA_CN);

  if (!title && !content) {
    return null;
  }

  if (title && content) {
    return `${title}\n${content}`;
  }

  return title ?? content ?? null;
}

function parseKstDateTime(value: string | null | undefined): string | null {
  const normalized = normalizeText(value ?? '');
  if (!normalized) {
    return null;
  }

  const matched = normalized.match(/^(\d{4})[./-](\d{2})[./-](\d{2})\s+(\d{2}):(\d{2})(?::(\d{2}))?/);
  if (!matched) {
    return null;
  }

  const [, year, month, day, hour, minute, second = '00'] = matched;
  const kstIso = `${year}-${month}-${day}T${hour}:${minute}:${second}+09:00`;
  const parsed = new Date(kstIso);
  if (Number.isNaN(parsed.getTime())) {
    return null;
  }

  return parsed.toISOString();
}

function formatKstCompactDate(date: Date): string {
  const kst = new Date(date.getTime() + KST_OFFSET_MS);
  const year = kst.getUTCFullYear();
  const month = String(kst.getUTCMonth() + 1).padStart(2, '0');
  const day = String(kst.getUTCDate()).padStart(2, '0');
  return `${year}${month}${day}`;
}

function normalizeServiceKey(value: string): string {
  if (!value.includes('%')) {
    return value;
  }

  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}
