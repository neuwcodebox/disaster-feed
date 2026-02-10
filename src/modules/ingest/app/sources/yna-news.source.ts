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

    const outOfScopeLabel = '범위외';

    let classified: Map<string, string> | null = null;
    try {
      classified = await this.labelClassifier.classifyBatch({
        labels: [...DISASTER_KIND_LABELS, outOfScopeLabel],
        items: batchItems,
        request: [
          'You are filtering news for display on a real-time public safety emergency dashboard in South Korea.',
          '',
          'Decide classification in this order:',
          '',
          '1) Scope gate: decide "범위외" vs in-scope (do this first; most errors come from this).',
          '   - "범위외" if it is clearly outside Korea / not affecting Korea, OR it is not mainly describing',
          '     a concrete public-safety incident, an active disruption, or an official alert that is/was executed.',
          '   - IMPORTANT: Do NOT require “still posing a real-time threat” as a condition.',
          '     A concrete incident in Korea is in-scope even if already contained',
          '     (e.g., "진화", "초진", "꺼져", "인명피해 없어" can still be in-scope).',
          '',
          '   Post-incident / admin filter (default to "범위외"):',
          '   - If the headline is mainly about AFTERMATH or ADMINISTRATIVE / JUDICIAL ACTION',
          '     (not the incident occurrence itself), classify as "범위외"',
          '     UNLESS it explicitly states an active operational impact',
          '     (e.g., active control, evacuation, dispatch, suppression, search, restoration-in-progress, outage).',
          '   - This applies EVEN IF the headline mentions an accident name, location, or past incident.',
          '     If the main action is authority-led administration or investigation, it is "범위외".',
          '',
          '   Typical aftermath/admin patterns:',
          '   - judicial/investigation: "구속영장", "압수수색", "기소", "재판/선고", "혐의", "수사", "조사"',
          '   - recovery/normalization: "통행 재개", "정상화", "해제", "복구 완료", "재개"',
          '   - victim/memorial/identity: "장례", "순직", "추모", "수습한 시신", "신원 확인"',
          '   - human-interest/recovery life: "이재민", "임시주택", "대피소", "지원/성금", "가보니"',
          '   - cause/defect analysis: "원인", "결함", "분석", "보고서"',
          '',
          '   - If the headline primarily reports the incident occurrence itself',
          '     (especially with concrete harm, damage, fire, explosion, collapse, or crash),',
          '     it is NOT aftermath.',
          '',
          '2) Terrorism override:',
          '   - If the event is framed as terrorism, terror threat, or terror attack,',
          '     OR public-safety operations responding to it (evacuation order, manhunt, emergency security),',
          '     classify as "테러" even if an explosion is involved.',
          '   - Terror follow-ups remain in-scope when they imply ongoing risk or operations',
          '     ("용의자 도주", "추가 공격 가능성", "수색", "대피", "경계 강화").',
          '   - Pure courtroom/sentencing long after with no ongoing risk/operation → "범위외".',
          '',
          '3) Category selection (situation-based; avoid keyword-only matching):',
          '',
          '   Civil-defense (민방공) rule (very strict and exclusive):',
          '   - Use "민방공" ONLY for military-attack or wartime civil-defense contexts:',
          '     air-raid, missile/artillery attack, CBRN (화생방/핵), air-raid sirens, blackout, attack-related evacuation or drills.',
          '   - If there is NO explicit military attack or air-raid context, do NOT use "민방공".',
          '     In such cases, prefer "범위외".',
          '   - Fire/police/agency readiness or holiday duty',
          '     (e.g., "특별경계근무", "비상근무", "대응 강화", "상황실 운영", "출동 태세")',
          '     is NOT civil defense and is usually "범위외" unless tied to an actual incident or active alert.',
          '',
          '   Fire-related disambiguation:',
          '   - Wildland: if the fire is in mountain/forest/wildland',
          '     ("산불", "야산", "임야", "산") → prefer "산불" even if later extinguished.',
          '   - Facility/structure: if it is a building, facility, worksite, or industrial object fire',
          '     (factory, house, plant, storage tank, wind turbine, etc.) → "화재".',
          '   - Spread mention rule: If the headline says the facility fire did NOT spread to wildland',
          '     (e.g., "산불로 확산 않아/확산 막아"),',
          '     keep it as "화재".',
          '',
          '   Road/vehicle rule (dataset-specific):',
          '   - If a vehicle catches fire on a road/highway/while driving',
          '     ("고속도로", "지선", "달리던", "화물차 불/화재", "타이어 파열 추정"),',
          '     treat it as a traffic-accident-type category, NOT general "화재",',
          '     unless it clearly becomes a separate building or wildland fire.',
          '',
          '   Traffic control vs restoration:',
          '   - Explicit active closure/control ("통제", "차단", "우회", "전면/부분 통제") → traffic-control type.',
          '   - If the headline is mainly about reopening/restoration',
          '     ("통행 재개", "통제 해제") → keep "범위외" per Step 1.',
          '',
          'Note: "AI" refers to avian influenza, NOT artificial intelligence.',
          'Do NOT rely on keywords alone; decide by what the headline is mainly about',
          '(incident/impact/alert vs aftermath/admin).',
        ].join('\n'),
      });
    } catch (error) {
      logger.error({ error, itemCount: batchItems.length }, 'LLM label classification failed');
      throw new Error('LLM label classification failed');
    }

    if (!classified) {
      logger.error('LLM label classification failed');
      throw new Error('LLM label classification failed');
    }

    const events: SourceEvent[] = [];
    for (const entry of classifiedItems) {
      const label = classified.get(entry.id) ?? outOfScopeLabel;
      if (label === '범위외') {
        continue;
      }

      const kind = DISASTER_KIND_BY_NAME[label] ?? EventKinds.Other;

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

  if (!title) {
    return null;
  }

  return title;
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
