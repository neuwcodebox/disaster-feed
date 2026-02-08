import { z } from 'zod';
import { logger } from '@/core/logger';
import { EventKinds, EventLevels, EventSources } from '@/modules/events/domain/event.enums';
import type { IRegionRepository } from '../../domain/port/region-repo.interface';
import type { Source, SourceEvent, SourceRunResult } from '../../domain/port/source.interface';
import type { LlmLabelClassifierService } from '../llm-label-classifier.service';
import { DISASTER_KIND_BY_NAME, DISASTER_KIND_LABELS } from './_shared/disaster-kind-labels';
import { fetchWithTimeout } from './_shared/fetch-with-timeout';
import { normalizeText } from './_shared/normalize';
import { resolveRegionCodeByPrefix } from './_shared/resolve-region-code';

const DISASTER_SMS_ENDPOINT = 'https://www.safekorea.go.kr/idsiSFK/sfk/cs/sua/web/DisasterSmsList.do';
const KST_OFFSET_MS = 9 * 60 * 60 * 1000;
const PAGE_SIZE = 50;
const SAFETY_FORECAST_KEYWORDS = ['예상', '예방', '우려', '주의', '유의'] as const;
const SAFETY_SYMBOL_KEYWORDS = ['▲', '△', '▷', '○'] as const;
const SAFETY_LEVEL_EXCLUDED_KEYWORDS = ['[기상청]', 'Heavy', 'Evacuation'] as const;

const schemaDisasterSmsItem = z.object({
  DSSTR_SE_NM: z.string().nullable().optional(), // 예: "한파"
  CREAT_DT: z.string(), // 예: "2025/12/25 15:31:33"
  RCV_AREA_NM: z.string(), // 예: "전라남도 곡성군 "
  MD101_SN: z.coerce.number().int(), // 예: 251341
  DSSTR_SE_ID: z.string(), // 예: "7"
  MSG_CN: z.string(), // 예: "금일부터 내리는 눈이..."
  EMRGNCY_STEP_NM: z.string(), // 예: "안전안내"
  EMRGNCY_STEP_ID: z.string().optional(), // 예: "4372"
  REGIST_DT: z.string().optional(), // 예: "2025-12-25 15:31:40.0"
  MSG_SE_CD: z.string().optional(), // 예: "cbs"
});

const schemaDisasterSmsResponse = z.object({
  disasterSmsList: z.array(schemaDisasterSmsItem),
});

type DisasterSmsItem = z.infer<typeof schemaDisasterSmsItem>;

export class DisasterSmsSource implements Source {
  public readonly sourceId = EventSources.SafekoreaSms;
  public readonly pollIntervalSec = 60;

  constructor(
    private readonly labelClassifier: DisasterSmsLabelClassifier,
    private readonly regionRepository: IRegionRepository,
  ) {}

  public async run(state: string | null): Promise<SourceRunResult> {
    const { startDate, endDate } = getKstDateRange(1);
    const payload = buildRequestBody(startDate, endDate);

    const response = await fetchWithTimeout({
      url: DISASTER_SMS_ENDPOINT,
      init: {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json;charset=UTF-8',
          Accept: 'application/json',
        },
        body: JSON.stringify(payload),
      },
    });

    if (!response) {
      throw new Error('Disaster SMS request failed');
    }

    const data = await response.json();

    const parsed = schemaDisasterSmsResponse.safeParse(data);
    if (!parsed.success) {
      logger.warn({ error: parsed.error }, 'Failed to parse disaster SMS response');
      throw new Error('Failed to parse disaster SMS response');
    }

    const lastSeenSerial = parseSerial(state);
    const items = filterNewItems(parsed.data.disasterSmsList, lastSeenSerial);
    const nextState = getNextSerialState(items, lastSeenSerial);
    const [resolvedKinds, resolvedLevels] = await Promise.all([
      resolveDisasterKinds(items, this.labelClassifier),
      resolveEmergencyLevels(items, this.labelClassifier),
    ]);
    const regionCodeCache = new Map<string, string | null>();

    const events: SourceEvent[] = [];
    for (const item of items) {
      const resolvedKind = resolvedKinds.get(item.MD101_SN) ?? EventKinds.Other;
      const resolvedLevel = resolvedLevels.get(item.MD101_SN) ?? mapEmergencyLevel(item.EMRGNCY_STEP_NM, item.MSG_CN);
      const regionText = normalizeRegionText(item.RCV_AREA_NM);
      const regionCodes = await resolveRegionCodes(regionText, this.regionRepository, regionCodeCache);
      events.push(toSourceEvent(item, resolvedKind, resolvedLevel, regionText, regionCodes));
    }

    return {
      events,
      nextState,
    };
  }
}

type DisasterSmsLabelClassifier = Pick<LlmLabelClassifierService, 'isEnabled' | 'classifyBatch'>;

function toSourceEvent(
  item: DisasterSmsItem,
  resolvedKind: EventKinds,
  resolvedLevel: EventLevels,
  regionText: string | null,
  regionCodes: string[] | null,
): SourceEvent {
  const sender = extractSenderName(item.MSG_CN);
  const titlePrefix = sender ?? pickRegionPrefix(regionText ?? '') ?? '';
  const disasterLabel = normalizeText(item.DSSTR_SE_NM) ?? '기타';
  return {
    kind: resolvedKind,
    title: `${titlePrefix} ${disasterLabel} ${item.EMRGNCY_STEP_NM}`.trim(),
    body: item.MSG_CN.trim(),
    occurredAt: parseKstDateTime(item.CREAT_DT),
    regionText,
    regionCodes,
    level: resolvedLevel,
    payload: item,
  };
}

const extractSenderName = (message: string): string | null => {
  const matched = message.match(/\[([^[\]]+)\]\s*$/);
  if (!matched) {
    return null;
  }

  const sender = matched[1].trim();
  return sender.length > 0 ? sender : null;
};

async function resolveDisasterKinds(
  items: DisasterSmsItem[],
  labelClassifier: DisasterSmsLabelClassifier,
): Promise<Map<number, EventKinds>> {
  const resolved = new Map<number, EventKinds>();
  const pending: Array<{ id: string; serial: number; text: string }> = [];
  const isClassifierEnabled = labelClassifier.isEnabled();

  for (const item of items) {
    const nameKind = resolveKindByName(item.DSSTR_SE_NM);
    if (nameKind) {
      resolved.set(item.MD101_SN, nameKind);
      continue;
    }

    if (!isClassifierEnabled) {
      resolved.set(item.MD101_SN, EventKinds.Other);
      continue;
    }

    const text = normalizeText(item.MSG_CN);
    if (!text) {
      resolved.set(item.MD101_SN, EventKinds.Other);
      continue;
    }

    pending.push({ id: String(item.MD101_SN), serial: item.MD101_SN, text });
  }

  if (!isClassifierEnabled || pending.length === 0) {
    return resolved;
  }

  let classified: Map<string, string> | null = null;
  try {
    classified = await labelClassifier.classifyBatch({
      labels: DISASTER_KIND_LABELS,
      items: pending.map((item) => ({
        id: item.id,
        text: item.text,
      })),
    });
  } catch (error) {
    logger.warn({ error, pendingCount: pending.length }, 'Disaster SMS kind classification failed, fallback to other');
  }

  for (const item of pending) {
    const label = classified?.get(item.id) ?? '기타';
    resolved.set(item.serial, DISASTER_KIND_BY_NAME[label] ?? EventKinds.Other);
  }

  return resolved;
}

function resolveKindByName(value: string | null | undefined): EventKinds | null {
  const normalized = normalizeText(value);
  if (!normalized) {
    return null;
  }

  const kind = DISASTER_KIND_BY_NAME[normalized];
  if (!kind || kind === EventKinds.Other) {
    return null;
  }

  return kind;
}

const pickRegionPrefix = (region: string): string | null => {
  const trimmed = region.trim();
  if (!trimmed) {
    return null;
  }

  const [first] = trimmed.split(/\s+/);
  return first ?? null;
};

function normalizeRegionText(value: string): string | null {
  const normalized = normalizeText(value.replace(/\s*,\s*/g, ', '));
  return normalized ?? null;
}

async function resolveRegionCodes(
  regionText: string | null,
  regionRepository: IRegionRepository,
  cache: Map<string, string | null>,
): Promise<string[] | null> {
  if (!regionText) {
    return null;
  }

  const parts = regionText.split(',').map((part) => part.trim());
  const regionCodes: string[] = [];
  const seen = new Set<string>();

  for (const part of parts) {
    if (!part) {
      continue;
    }
    if (part === '전국') {
      if (!seen.has('0000000000')) {
        seen.add('0000000000');
        regionCodes.push('0000000000');
      }
      continue;
    }

    const searchText = normalizeRegionSearchText(part);
    if (!searchText) {
      continue;
    }

    const code = await resolveRegionCodeByPrefix(searchText, regionRepository, cache);
    if (!code || seen.has(code)) {
      continue;
    }
    seen.add(code);
    regionCodes.push(code);
  }

  return regionCodes.length > 0 ? regionCodes : null;
}

function normalizeRegionSearchText(value: string): string | null {
  if (value.endsWith(' 전체')) {
    const trimmed = value.slice(0, -3).trimEnd();
    return trimmed ?? null;
  }
  return value;
}

function isEvacuationOrderOrAdvisory(message: string): boolean {
  const trimmed = message.trimStart();
  const matched = trimmed.match(/^\(([^)]*)\)/);
  if (!matched) {
    return false;
  }

  const head = matched[1];
  if (head.includes('해제')) {
    return false;
  }

  return head.includes('대피명령') || head.includes('대피권고');
}

async function resolveEmergencyLevels(
  items: DisasterSmsItem[],
  labelClassifier: DisasterSmsLabelClassifier,
): Promise<Map<number, EventLevels>> {
  const resolved = new Map<number, EventLevels>();
  const pending: Array<{ id: string; serial: number; text: string }> = [];
  const isClassifierEnabled = labelClassifier.isEnabled();

  for (const item of items) {
    if (!isSafetyEmergencyStep(item.EMRGNCY_STEP_NM)) {
      resolved.set(item.MD101_SN, mapEmergencyLevel(item.EMRGNCY_STEP_NM, item.MSG_CN));
      continue;
    }

    if (isEvacuationOrderOrAdvisory(item.MSG_CN)) {
      resolved.set(item.MD101_SN, EventLevels.Moderate);
      continue;
    }

    const normalizedMessage = normalizeText(item.MSG_CN) ?? '';
    const keywordMatch = matchSafetyLevelKeywords(normalizedMessage);

    if (keywordMatch.hasExcludedKeyword) {
      resolved.set(item.MD101_SN, EventLevels.Minor);
      continue;
    }

    if (keywordMatch.hasForecastKeyword && keywordMatch.hasSymbolKeyword) {
      resolved.set(item.MD101_SN, EventLevels.Info);
      continue;
    }

    if (!keywordMatch.hasAnyKeyword || !isClassifierEnabled || !normalizedMessage) {
      resolved.set(item.MD101_SN, EventLevels.Minor);
      continue;
    }

    pending.push({
      id: String(item.MD101_SN),
      serial: item.MD101_SN,
      text: normalizedMessage,
    });
  }

  if (!isClassifierEnabled || pending.length === 0) {
    return resolved;
  }

  const situationLabel = '사건발생';
  const guidanceLabel = '예방안내';
  const otherLabel = '기타';

  let classified: Map<string, string> | null = null;
  try {
    classified = await labelClassifier.classifyBatch({
      labels: [situationLabel, guidanceLabel, otherLabel],
      items: pending.map((item) => ({
        id: item.id,
        text: item.text,
      })),
      request: [
        'You are a strict classifier for Korean emergency alert messages (재난문자) used on a real-time public safety dashboard in South Korea.',
        'Classify based on factual assertions about the REAL WORLD, not on official announcement states.',
        `Output "${situationLabel}" only when the text asserts a real-world incident/disruption on the ground: something physically happened, is happening, or a disruption is actually in effect (e.g., damage/failure/accident/fire/flooding/outage/closure already happening).`,
        `If a confirmed cause-event is stated and impacts are described as "예상/전망", only the impacts are predicted; the cause-event is still real => "${situationLabel}". Advice does not cancel a confirmed real-world assertion.`,
        `Output "${guidanceLabel}" when the text does NOT assert a real-world incident/disruption, and is mainly warning/forecast/preparedness guidance. Treat official announcements (특보/경보/주의보/발효/발령/단계) as "${guidanceLabel}" by default because they are announcement/status, not proof that a real incident has occurred.`,
        `An announcement becomes "${situationLabel}" only if the SAME message also asserts a real-world incident/disruption already happening.`,
        `Output "${otherLabel}" only when it is not meaningfully about public-safety risk in South Korea, or when it is too unclear to decide whether it asserts a real-world incident/disruption versus only guidance.`,
        'Tie-breaker:',
        `- If you are unsure whether the text asserts a real-world incident/disruption, choose "${otherLabel}" (not "${guidanceLabel}" and not "${situationLabel}").`,
        'Mini examples (follow these):',
        `- "대설경보, 미끄럼 주의" => "${guidanceLabel}" (announcement + advice; no real-world incident asserted)`,
        `- "OO 파손으로 인해 단수 예상, 대비 바랍니다" => "${situationLabel}" (real-world cause-event asserted; only impact timing is expected)`,
      ].join(' '),
    });
  } catch (error) {
    logger.warn(
      { error, pendingCount: pending.length },
      'Disaster SMS level classification failed, fallback to default safety level',
    );
  }

  for (const item of pending) {
    const label = classified?.get(item.id);
    resolved.set(item.serial, label === guidanceLabel ? EventLevels.Info : EventLevels.Minor);
  }

  return resolved;
}

function matchSafetyLevelKeywords(message: string): {
  hasForecastKeyword: boolean;
  hasSymbolKeyword: boolean;
  hasAnyKeyword: boolean;
  hasExcludedKeyword: boolean;
} {
  const hasExcludedKeyword = includesAnyKeyword(message, SAFETY_LEVEL_EXCLUDED_KEYWORDS);
  if (hasExcludedKeyword) {
    return {
      hasForecastKeyword: false,
      hasSymbolKeyword: false,
      hasAnyKeyword: false,
      hasExcludedKeyword: true,
    };
  }

  const hasForecastKeyword = includesAnyKeyword(message, SAFETY_FORECAST_KEYWORDS);
  const hasSymbolKeyword = includesAnyKeyword(message, SAFETY_SYMBOL_KEYWORDS);
  return {
    hasForecastKeyword,
    hasSymbolKeyword,
    hasAnyKeyword: hasForecastKeyword || hasSymbolKeyword,
    hasExcludedKeyword: false,
  };
}

function includesAnyKeyword(message: string, keywords: readonly string[]): boolean {
  for (const keyword of keywords) {
    if (message.includes(keyword)) {
      return true;
    }
  }
  return false;
}

function isSafetyEmergencyStep(emergencyStep: string): boolean {
  return emergencyStep.includes('안전');
}

function mapEmergencyLevel(emergencyStep: string, message: string): EventLevels {
  if (emergencyStep.includes('위급')) {
    return EventLevels.Critical;
  }
  if (emergencyStep.includes('긴급')) {
    return EventLevels.Severe;
  }
  if (isSafetyEmergencyStep(emergencyStep)) {
    if (isEvacuationOrderOrAdvisory(message)) {
      return EventLevels.Moderate;
    }
    return EventLevels.Minor;
  }
  return EventLevels.Info;
}

const filterNewItems = (items: DisasterSmsItem[], lastSeenSerial: number | null): DisasterSmsItem[] => {
  if (lastSeenSerial === null) {
    return items;
  }

  return items.filter((item) => item.MD101_SN > lastSeenSerial);
};

const parseSerial = (value: string | null): number | null => {
  if (!value) {
    return null;
  }

  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    return null;
  }

  return Math.trunc(parsed);
};

const getNextSerialState = (items: DisasterSmsItem[], lastSeenSerial: number | null): string | null => {
  if (items.length === 0) {
    return lastSeenSerial === null ? null : String(lastSeenSerial);
  }

  const maxSerial = Math.max(...items.map((item) => item.MD101_SN));
  return String(maxSerial);
};

const buildRequestBody = (startDate: string, endDate: string) => {
  const pageSizeText = String(PAGE_SIZE);

  return {
    searchInfo: {
      pageIndex: '1',
      pageUnit: pageSizeText,
      pageSize: pageSizeText,
      firstIndex: '1',
      lastIndex: pageSizeText,
      recordCountPerPage: pageSizeText,
      searchBgnDe: startDate,
      searchEndDe: endDate,
      searchGb: '1',
      searchWrd: '',
      rcv_Area_Id: '',
      dstr_se_Id: '',
      c_ocrc_type: '',
      sbLawArea1: '',
      sbLawArea2: '',
      sbLawArea3: '',
    },
  };
};

const parseKstDateTime = (value: string): string | null => {
  const matched = value.match(/^(\d{4})[./-](\d{2})[./-](\d{2})\s+(\d{2}):(\d{2}):(\d{2})/);
  if (!matched) {
    return null;
  }

  const [, year, month, day, hour, minute, second] = matched;
  const kstIso = `${year}-${month}-${day}T${hour}:${minute}:${second}+09:00`;
  const parsed = new Date(kstIso);

  if (Number.isNaN(parsed.getTime())) {
    return null;
  }

  return parsed.toISOString();
};

const getKstDateRange = (daysBack: number) => {
  const nowUtc = new Date(Date.now() + KST_OFFSET_MS);
  const endDate = formatUtcDate(nowUtc);
  const startUtc = new Date(nowUtc);
  startUtc.setUTCDate(startUtc.getUTCDate() - daysBack);

  return {
    startDate: formatUtcDate(startUtc),
    endDate,
  };
};

const formatUtcDate = (date: Date): string => {
  const year = date.getUTCFullYear();
  const month = String(date.getUTCMonth() + 1).padStart(2, '0');
  const day = String(date.getUTCDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
};
