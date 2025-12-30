import { z } from 'zod';
import { logger } from '@/core/logger';
import type { EventPayload } from '@/modules/events/domain/entity/event.entity';
import { EventKinds, EventLevels, EventSources } from '@/modules/events/domain/event.enums';
import type { Source, SourceEvent, SourceRunResult } from '../../domain/port/source.interface';
import type { LlmLabelClassifierService } from '../llm-label-classifier.service';
import { fetchWithTimeout } from './_shared/fetch-with-timeout';

const DISASTER_SMS_ENDPOINT = 'https://www.safekorea.go.kr/idsiSFK/sfk/cs/sua/web/DisasterSmsList.do';
const KST_OFFSET_MS = 9 * 60 * 60 * 1000;
const PAGE_SIZE = 50;

const schemaDisasterSmsItem = z.object({
  DSSTR_SE_NM: z.string(), // 예: "한파"
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

const DISASTER_KIND_BY_NAME: Record<string, EventKinds> = {
  AI: EventKinds.Ai,
  가뭄: EventKinds.Drought,
  가축질병: EventKinds.Livestock,
  강풍: EventKinds.Wind,
  건조: EventKinds.Dry,
  교통: EventKinds.Transport,
  교통사고: EventKinds.TrafficCrash,
  교통통제: EventKinds.TrafficCtrl,
  금융: EventKinds.Finance,
  기타: EventKinds.Other,
  대설: EventKinds.Snow,
  미세먼지: EventKinds.FineDust,
  민방공: EventKinds.CivDef,
  붕괴: EventKinds.Collapse,
  산불: EventKinds.Wildfire,
  산사태: EventKinds.Landslide,
  수도: EventKinds.Water,
  안개: EventKinds.Fog,
  에너지: EventKinds.Energy,
  전염병: EventKinds.Epidemic,
  정전: EventKinds.Blackout,
  지진: EventKinds.Quake,
  지진해일: EventKinds.Tsunami,
  태풍: EventKinds.Typhoon,
  테러: EventKinds.Terror,
  통신: EventKinds.Telecom,
  폭발: EventKinds.Explosion,
  폭염: EventKinds.Heat,
  풍랑: EventKinds.HighSeas,
  한파: EventKinds.Cold,
  호우: EventKinds.Rain,
  홍수: EventKinds.Flood,
  화재: EventKinds.Fire,
  환경오염사고: EventKinds.Pollution,
  황사: EventKinds.YellowDust,
};

const DISASTER_KIND_LABELS = Object.keys(DISASTER_KIND_BY_NAME) as [string, ...string[]];

export class DisasterSmsSource implements Source {
  public readonly sourceId = EventSources.SafekoreaSms;
  public readonly pollIntervalSec = 60;

  constructor(private readonly labelClassifier: LlmLabelClassifierService) {}

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
    const resolvedKinds = await resolveDisasterKinds(items, this.labelClassifier);

    const events: SourceEvent[] = [];
    for (const item of items) {
      const resolvedKind = resolvedKinds.get(item.MD101_SN) ?? EventKinds.Other;
      events.push(toSourceEvent(item, resolvedKind));
    }

    return {
      events,
      nextState,
    };
  }
}

function toSourceEvent(item: DisasterSmsItem, resolvedKind: EventKinds): SourceEvent {
  const region = item.RCV_AREA_NM.replace(/\s*,\s*/g, ', ').trim();
  const sender = extractSenderName(item.MSG_CN);
  const titlePrefix = sender ?? pickRegionPrefix(region) ?? '';
  const disasterLabel = item.DSSTR_SE_NM.trim() || '기타';
  return {
    kind: resolvedKind,
    title: `${titlePrefix} ${disasterLabel} ${item.EMRGNCY_STEP_NM}`.trim(),
    body: item.MSG_CN.trim(),
    occurredAt: parseKstDateTime(item.CREAT_DT),
    regionText: region || null,
    level: mapEmergencyLevel(item.EMRGNCY_STEP_NM),
    payload: buildPayload(item),
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
  labelClassifier: LlmLabelClassifierService,
): Promise<Map<number, EventKinds>> {
  const resolved = new Map<number, EventKinds>();
  const pending: Array<{ id: string; serial: number; text: string }> = [];
  const isClassifierEnabled = labelClassifier.isEnabled();

  for (const item of items) {
    const normalized = item.DSSTR_SE_NM.trim();
    const directKind = DISASTER_KIND_BY_NAME[normalized];
    if (directKind && directKind !== EventKinds.Other) {
      resolved.set(item.MD101_SN, directKind);
      continue;
    }

    if (!isClassifierEnabled) {
      resolved.set(item.MD101_SN, EventKinds.Other);
      continue;
    }

    const text = item.MSG_CN.trim();
    if (!text) {
      resolved.set(item.MD101_SN, EventKinds.Other);
      continue;
    }

    pending.push({ id: String(item.MD101_SN), serial: item.MD101_SN, text });
  }

  if (!isClassifierEnabled || pending.length === 0) {
    return resolved;
  }

  const classified = await labelClassifier.classifyBatch({
    labels: DISASTER_KIND_LABELS,
    items: pending.map((item) => ({
      id: item.id,
      text: item.text,
    })),
  });

  for (const item of pending) {
    const label = classified?.get(item.id) ?? '기타';
    resolved.set(item.serial, DISASTER_KIND_BY_NAME[label] ?? EventKinds.Other);
  }

  return resolved;
}

const pickRegionPrefix = (region: string): string | null => {
  const trimmed = region.trim();
  if (!trimmed) {
    return null;
  }

  const [first] = trimmed.split(/\s+/);
  return first ?? null;
};

const buildPayload = (item: DisasterSmsItem): EventPayload => {
  return {
    serial: item.MD101_SN,
    disasterTypeId: item.DSSTR_SE_ID,
    message: item.MSG_CN,
    emergencyStepId: item.EMRGNCY_STEP_ID ?? null,
    messageType: item.MSG_SE_CD ?? null,
    createdAt: item.CREAT_DT,
    registeredAt: item.REGIST_DT ?? null,
  };
};

const mapEmergencyLevel = (value: string): EventLevels => {
  if (value.includes('위급')) {
    return EventLevels.Critical;
  }
  if (value.includes('긴급')) {
    return EventLevels.Severe;
  }
  if (value.includes('안전')) {
    return EventLevels.Minor;
  }
  return EventLevels.Info;
};

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
