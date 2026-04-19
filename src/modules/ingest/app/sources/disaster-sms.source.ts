import { type Cheerio, type CheerioAPI, load } from 'cheerio';
import type { AnyNode } from 'domhandler';
import { logger } from '@/core/logger';
import type { EventPayload } from '@/modules/events/domain/entity/event.entity';
import { EventKinds, EventLevels, EventSources } from '@/modules/events/domain/event.enums';
import type { IRegionRepository } from '../../domain/port/region-repo.interface';
import type { Source, SourceEvent, SourceRunResult } from '../../domain/port/source.interface';
import type { LlmLabelClassifierService } from '../llm-label-classifier.service';
import { DISASTER_KIND_BY_NAME, DISASTER_KIND_LABELS } from './_shared/disaster-kind-labels';
import { fetchWithTimeout } from './_shared/fetch-with-timeout';
import { normalizeText } from './_shared/normalize';
import { resolveRegionCodeByPrefix } from './_shared/resolve-region-code';

const DISASTER_SMS_ENDPOINT = 'https://safekorea.go.kr/safekorea-kor/ctim/cmsg/calamitySms.do?menuSn=34&firstYn=Y';
const DISASTER_SMS_LIST_SELECTOR = '#content_area > div.cont-area > div.brd-listarea > ul';

// 예방안내/사건발생 분류를 하지 않을 키워드들
const SAFETY_LEVEL_EXCLUDED_KEYWORDS = ['[기상청]', 'Heavy', 'Evacuation', '비상저감조치', '지진발생'] as const;

// 다음 3가지 키워드들 중 한 종류가 검출되면 분류기를 탐, 두 종류 이상이 검출되면 레벨 격하
// 예방안내를 의미하는 키워드들
const SAFETY_PRECAUTION_KEYWORDS = ['예상', '예방', '우려', '주의', '유의', '자제', '당부', '협조'] as const;
// 예방안내시 자주 사용되는 기호들
const SAFETY_INFO_SYMBOL_KEYWORDS = ['!', '▲', '△', '▶', '▷', '●', '○', '◆', '◇', '■', '□'] as const;
// 예방안내시 자주 언급되는 키워드들
const SAFETY_INFO_DIRECT_KEYWORDS = [
  '불씨',
  '안부',
  '담배불',
  '담뱃불',
  '난방기',
  '과태료',
  '연휴',
  '명절',
  '불법',
  '인화물질',
  '마스크',
  '출근',
  '퇴근',
  '소각',
] as const;

// 사건발생을 의미하는 키워드들 (레벨 격하 조건이 만족되어도 이 키워드가 검출되면 분류기를 탐)
const SAFETY_INCIDENT_KEYWORDS = ['이동제한', '통제', '붕괴', '대피', '유출', '누출', '우회', '연기'] as const;

type DisasterSmsItem = {
  serial: number;
  disasterType: string | null;
  message: string;
  sentAt: string | null;
  emergencyStep: string;
  regionText: string | null;
};

type DisasterSmsRowMetadata = {
  sentAt: string | null;
  emergencyStep: string;
  regionText: string | null;
};

type DisasterSmsLabelClassifier = Pick<LlmLabelClassifierService, 'isEnabled' | 'classifyBatch'>;

export class DisasterSmsSource implements Source {
  public readonly sourceId = EventSources.SafekoreaSms;
  public readonly pollIntervalSec = 60;

  constructor(
    private readonly labelClassifier: DisasterSmsLabelClassifier,
    private readonly regionRepository: IRegionRepository,
  ) {}

  public async run(state: string | null): Promise<SourceRunResult> {
    const response = await fetchWithTimeout({
      url: DISASTER_SMS_ENDPOINT,
      init: {
        method: 'GET',
        headers: {
          Accept: 'text/html,application/xhtml+xml',
        },
      },
    });

    if (!response) {
      throw new Error('Disaster SMS request failed');
    }

    const html = await response.text();
    const parsedItems = parseDisasterSmsItems(html);
    const lastSeenSerial = parseSerial(state);
    const items = filterNewItems(parsedItems, lastSeenSerial);
    const nextState = getNextSerialState(items, lastSeenSerial);
    const [resolvedKinds, resolvedLevels] = await Promise.all([
      resolveDisasterKinds(items, this.labelClassifier),
      resolveEmergencyLevels(items, this.labelClassifier),
    ]);
    const regionCodeCache = new Map<string, string | null>();

    const events: SourceEvent[] = [];
    for (const item of items) {
      const resolvedKind = resolvedKinds.get(item.serial) ?? EventKinds.Other;
      const resolvedLevel = resolvedLevels.get(item.serial) ?? mapEmergencyLevel(item.emergencyStep, item.message);
      const regionCodes = await resolveRegionCodes(item.regionText, this.regionRepository, regionCodeCache);
      events.push(toSourceEvent(item, resolvedKind, resolvedLevel, item.regionText, regionCodes));
    }

    return {
      events,
      nextState,
    };
  }
}

function parseDisasterSmsItems(html: string): DisasterSmsItem[] {
  const $ = load(html);
  const list = $(DISASTER_SMS_LIST_SELECTOR).first();
  if (list.length === 0) {
    logger.warn({ selector: DISASTER_SMS_LIST_SELECTOR }, 'Failed to find disaster SMS list');
    throw new Error('Failed to find disaster SMS list');
  }

  const items: DisasterSmsItem[] = [];
  const rows = list.find('li').toArray();

  for (const row of rows) {
    const contentCell = $(row).find('.brd-context').first();
    const messageLink = contentCell.find('h3.title-text a').first();
    const message = normalizeText(messageLink.text());
    const serial = extractSerialFromHref(messageLink.attr('href'));
    if (serial === null || !message) {
      logger.warn(
        {
          href: messageLink.attr('href') ?? null,
          message,
        },
        'Failed to parse disaster SMS row with invalid serial or message',
      );
      throw new Error('Failed to parse disaster SMS row');
    }

    const metadata = parseDisasterSmsRowMetadata($, contentCell.find('.brd-infolist').first());
    items.push({
      serial,
      disasterType: metadata.disasterType,
      message,
      sentAt: metadata.sentAt,
      emergencyStep: metadata.emergencyStep,
      regionText: metadata.regionText,
    });
  }

  return items;
}

function parseDisasterSmsRowMetadata(
  $: CheerioAPI,
  infoList: Cheerio<AnyNode>,
): DisasterSmsRowMetadata & { disasterType: string | null } {
  if (infoList.length === 0) {
    throw new Error('Failed to parse disaster SMS row metadata');
  }

  const fields = new Map<string, string>();
  const infoItems = infoList.find('p').toArray();

  for (const infoItem of infoItems) {
    const labelElement = $(infoItem).find('span').first();
    const rawLabel = normalizeText(labelElement.text().replace(/\u00a0/g, ' '));
    if (!rawLabel) {
      continue;
    }

    const normalizedKey = normalizeText(rawLabel.replace(/\s*:\s*$/, ''));
    const normalizedValue = normalizeText(
      $(infoItem)
        .clone()
        .find('span')
        .remove()
        .end()
        .text()
        .replace(/\u00a0/g, ' '),
    );
    if (!normalizedKey || !normalizedValue) {
      continue;
    }

    fields.set(normalizedKey, normalizedValue);
  }

  const sentAt = fields.get('발송일시');
  const emergencyStep = fields.get('긴급단계');
  const disasterType = fields.get('재해구분') ?? null;
  if (!sentAt || !emergencyStep) {
    logger.warn({ fields: Object.fromEntries(fields) }, 'Failed to parse disaster SMS row metadata');
    throw new Error('Failed to parse disaster SMS row metadata');
  }

  return {
    disasterType,
    sentAt,
    emergencyStep,
    regionText: normalizeRegionText(fields.get('송출지역') ?? ''),
  };
}

function extractSerialFromHref(value: string | undefined): number | null {
  if (!value) {
    return null;
  }

  const matched = value.match(/onSubmit\(['"]?(\d+)['"]?\)/);
  if (!matched) {
    return null;
  }

  const serial = Number(matched[1]);
  if (!Number.isInteger(serial)) {
    return null;
  }

  return serial;
}

function toSourceEvent(
  item: DisasterSmsItem,
  resolvedKind: EventKinds,
  resolvedLevel: EventLevels,
  regionText: string | null,
  regionCodes: string[] | null,
): SourceEvent {
  const sender = extractSenderName(item.message);
  const titlePrefix = sender ?? pickRegionPrefix(regionText ?? '') ?? '';
  const disasterLabel = normalizeText(item.disasterType) ?? '기타';
  const emergencyStep = normalizeText(item.emergencyStep);

  return {
    kind: resolvedKind,
    title: [titlePrefix, disasterLabel, emergencyStep].filter((value): value is string => Boolean(value)).join(' '),
    body: item.message.trim(),
    occurredAt: item.sentAt ? parseKstDateTime(item.sentAt) : null,
    regionText,
    regionCodes,
    level: resolvedLevel,
    payload: buildPayload(item),
  };
}

function buildPayload(item: DisasterSmsItem): EventPayload {
  return {
    serial: item.serial,
    disasterType: item.disasterType,
    message: item.message,
    sentAt: item.sentAt,
    sentAtIso: item.sentAt ? parseKstDateTime(item.sentAt) : null,
    emergencyStep: normalizeText(item.emergencyStep),
    regionText: item.regionText,
  };
}

function extractSenderName(message: string): string | null {
  const matched = message.match(/\[([^[\]]+)\]\s*$/);
  if (!matched) {
    return null;
  }

  const sender = matched[1].trim();
  return sender.length > 0 ? sender : null;
}

async function resolveDisasterKinds(
  items: DisasterSmsItem[],
  labelClassifier: DisasterSmsLabelClassifier,
): Promise<Map<number, EventKinds>> {
  const resolved = new Map<number, EventKinds>();
  const pending: Array<{ id: string; serial: number; text: string }> = [];
  const isClassifierEnabled = labelClassifier.isEnabled();

  for (const item of items) {
    const nameKind = resolveKindByName(item.disasterType);
    if (nameKind) {
      resolved.set(item.serial, nameKind);
      continue;
    }

    if (!isClassifierEnabled) {
      resolved.set(item.serial, EventKinds.Other);
      continue;
    }

    const text = normalizeText(item.message);
    if (!text) {
      resolved.set(item.serial, EventKinds.Other);
      continue;
    }

    pending.push({ id: String(item.serial), serial: item.serial, text });
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
      request: [
        'Prefer labels that describe a CONFIRMED event over labels that describe risk, prevention, guidance, or general context.',
        '- "민방공" is ONLY for wartime / national-security civil-defense alerts (e.g., air-raid/missile warnings, evacuation orders, civil-defense drills/sirens). NEVER use "민방공" for general safety tips, accident prevention, weather-related cautions, or ambiguous public-safety notices. If it’s not clearly civil-defense, choose another label; if none fits, choose "기타".',
        '- "AI" means Avian Influenza (조류인플루엔자), NOT Artificial Intelligence. Use "AI" only for messages about poultry/birds + outbreaks/suspected/confirmed cases, quarantine, culling, movement restrictions, test results, etc. If the text mentions “AI” as Artificial Intelligence or is unclear, prefer "기타".',
        '- "테러" is ONLY for terrorism-related threats/incidents or official counter-terror alerts. Do NOT use it for ordinary crime, accidents, or vague danger warnings; if unclear, prefer "기타".',
        '- "사이버" is ONLY for cyber incidents (hacking, ransomware, DDoS, malware, data breaches, unauthorized access). If it is primarily a communication/service outage without cyber-attack evidence, consider "통신" instead; if still unclear, use "기타".',
        '- "금융" is ONLY for financial issues such as voice phishing/smishing, bank/card/account fraud, financial-institution service disruptions, or payment system incidents. If unclear, prefer "기타".',
        '- Default rule for "기타": If no label is a clear match, choose "기타".',
      ].join('\n'),
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

function pickRegionPrefix(region: string): string | null {
  const trimmed = region.trim();
  if (!trimmed) {
    return null;
  }

  const [first] = trimmed.split(/\s+/);
  return first ?? null;
}

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
  if (/evacuation/i.test(message)) {
    return true;
  }

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
    if (!isSafetyEmergencyStep(item.emergencyStep)) {
      resolved.set(item.serial, mapEmergencyLevel(item.emergencyStep, item.message));
      continue;
    }

    if (isEvacuationOrderOrAdvisory(item.message)) {
      resolved.set(item.serial, EventLevels.Moderate);
      continue;
    }

    const normalizedMessage = normalizeText(item.message) ?? '';
    const keywordSignals = matchSafetyLevelKeywords(normalizedMessage);

    if (keywordSignals.hasExcludedKeyword) {
      resolved.set(item.serial, EventLevels.Minor);
      continue;
    }

    if (keywordSignals.shouldSetInfoImmediately) {
      resolved.set(item.serial, EventLevels.Info);
      continue;
    }

    if (!keywordSignals.hasClassifierTriggerKeyword || !isClassifierEnabled || !normalizedMessage) {
      resolved.set(item.serial, EventLevels.Minor);
      continue;
    }

    pending.push({
      id: String(item.serial),
      serial: item.serial,
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
        'You are classifying Korean emergency alert messages (재난문자) for a real-time public safety dashboard in South Korea.',
        `"${situationLabel}" = a confirmed on-the-ground situation exists (a real incident/failure/disruption is true now) OR a concrete operation is being executed / will be executed as a definite notice.`,
        `"${guidanceLabel}" = no confirmed situation is asserted; mainly forecast/warning/prevention guidance/campaign.`,
        `"${otherLabel}" = not a public-safety message, or too unclear to decide.`,
        `Important clarification: alarming incident-like wording (e.g., broad claims that something is "happening") is NOT sufficient for "${situationLabel}" unless the message also includes at least one concrete on-the-ground operational fact (e.g., response/activity in progress, control/closure/outage in effect, evacuation/area control, recovery work, affected service/route currently impacted, or a definite execution notice).`,
        `If the message is dominated by bans/precautions/safety rules and lacks such concrete operational facts, classify it as "${guidanceLabel}" even if it uses strong incident-like wording.`,
        `Key rule (do not ignore this): If the text contains a CONFIRMED CAUSE stated as fact and then gives predicted impacts or preparedness guidance, classify as "${situationLabel}".`,
        'A confirmed cause is a statement like "X로 인해/때문에" where X is written as an already-true event/failure/condition (the prediction applies to the impact, not to whether X happened).',
        `Treat official advisories/warnings by themselves as "${guidanceLabel}" unless the same message also asserts a confirmed situation or a definite execution notice.`,
        `If the message mainly announces the end/clearance/normalization of a restriction or disruption (e.g., control lifted, reopened, restored), classify it as "${guidanceLabel}" unless it also reports a new or ongoing incident.`,
        `Tie-breaker: If you are deciding between "${situationLabel}" and "${guidanceLabel}" and the message is dominated by bans/precautions (no explicit response/control/disruption/execution notice), default to "${guidanceLabel}".`,
        'Mini examples (follow these):',
        `* "상수도관 파손으로 단수 예상, 대비 바랍니다" => "${situationLabel}" (cause is confirmed; only impact is expected)`,
        `* "대설경보, 미끄럼 주의" => "${guidanceLabel}" (advisory + guidance only)`,
        `* "산불 관련 예방 수칙/금지 안내" => "${guidanceLabel}" (campaign/guidance-dominant)`,
        `* "헬기 살수 작업 예정 안내, 인근 안전 유의" => "${situationLabel}" (definite execution notice)`,
        `* "전국 산불 동시다발 발생! 불씨 관리 철저, 입산시 화기 소지 금지, 담뱃불 투기 금지" => "${guidanceLabel}" (campaign/guidance-dominant; no concrete on-the-ground operational facts)`,
        `* "금일 어린이대공원 주변 멧돼지 출몰, 인근 주민께서는 안전에 유의하세요" => "${situationLabel}" (confirmed local sighting; guidance follows but does not change the fact that a real situation is already true)`,
      ].join('\n'),
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
  hasClassifierTriggerKeyword: boolean;
  shouldSetInfoImmediately: boolean;
  hasExcludedKeyword: boolean;
} {
  const hasExcludedKeyword = includesAnyKeyword(message, SAFETY_LEVEL_EXCLUDED_KEYWORDS);
  if (hasExcludedKeyword) {
    return {
      hasClassifierTriggerKeyword: false,
      shouldSetInfoImmediately: false,
      hasExcludedKeyword: true,
    };
  }

  const hasPrecautionKeyword = includesAnyKeyword(message, SAFETY_PRECAUTION_KEYWORDS);
  const hasInfoSymbolKeyword = includesAnyKeyword(message, SAFETY_INFO_SYMBOL_KEYWORDS);
  const hasInfoDirectKeyword = includesAnyKeyword(message, SAFETY_INFO_DIRECT_KEYWORDS);
  const hasIncidentKeyword = includesAnyKeyword(message, SAFETY_INCIDENT_KEYWORDS);
  const matchedKeywordTypeCount =
    Number(hasPrecautionKeyword) + Number(hasInfoSymbolKeyword) + Number(hasInfoDirectKeyword);
  const hasMultipleSafetyKeywords = matchedKeywordTypeCount >= 2;
  const hasClassifierTriggerKeyword =
    matchedKeywordTypeCount === 1 || (hasMultipleSafetyKeywords && hasIncidentKeyword);
  const shouldSetInfoImmediately = hasMultipleSafetyKeywords && !hasIncidentKeyword;

  return {
    hasClassifierTriggerKeyword,
    shouldSetInfoImmediately,
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

function filterNewItems(items: DisasterSmsItem[], lastSeenSerial: number | null): DisasterSmsItem[] {
  if (lastSeenSerial === null) {
    return items;
  }

  return items.filter((item) => item.serial > lastSeenSerial);
}

function parseSerial(value: string | null): number | null {
  if (!value) {
    return null;
  }

  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    return null;
  }

  return Math.trunc(parsed);
}

function getNextSerialState(items: DisasterSmsItem[], lastSeenSerial: number | null): string {
  if (items.length === 0) {
    return lastSeenSerial === null ? '' : String(lastSeenSerial);
  }

  const maxSerial = Math.max(...items.map((item) => item.serial));
  return String(maxSerial);
}

function parseKstDateTime(value: string): string | null {
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
}
