import { z } from 'zod';
import { logger } from '@/core/logger';
import type { EventPayload } from '@/modules/events/domain/entity/event.entity';
import { EventKind, EventLevel } from '@/modules/events/domain/event.enums';
import type { Source, SourceEvent } from '../../domain/port/source.interface';

const DISASTER_SMS_ENDPOINT = 'https://www.safetydata.go.kr/idsiSFK/sfk/cs/sua/web/DisasterSmsList.do';
const DISASTER_SMS_KIND = EventKind.Cbs;
const KST_OFFSET_MS = 9 * 60 * 60 * 1000;
const REQUEST_TIMEOUT_MS = 10000;
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

export class DisasterSmsSource implements Source {
  public readonly sourceId = 'safekorea_sms';
  public readonly pollIntervalSec = 180;

  private lastSeenSerial: number | null = null;

  public async run(): Promise<SourceEvent[]> {
    const { startDate, endDate } = getKstDateRange(1);
    const payload = buildRequestBody(startDate, endDate);

    const response = await fetchWithTimeout(DISASTER_SMS_ENDPOINT, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json;charset=UTF-8',
        Accept: 'application/json',
      },
      body: JSON.stringify(payload),
    });

    if (!response) {
      return [];
    }

    const data = await parseJsonResponse(response, this.sourceId);
    if (!data) {
      return [];
    }

    const parsed = schemaDisasterSmsResponse.safeParse(data);
    if (!parsed.success) {
      logger.warn({ error: parsed.error }, 'Failed to parse disaster SMS response');
      return [];
    }

    const items = filterNewItems(parsed.data.disasterSmsList, this.lastSeenSerial);
    if (items.length > 0) {
      this.lastSeenSerial = Math.max(...items.map((item) => item.MD101_SN));
    }

    return items.map((item) => toSourceEvent(item));
  }
}

const toSourceEvent = (item: DisasterSmsItem): SourceEvent => {
  const region = item.RCV_AREA_NM.trim();
  return {
    kind: DISASTER_SMS_KIND,
    title: `${region} ${item.DSSTR_SE_NM} ${item.EMRGNCY_STEP_NM}`.trim(),
    body: item.MSG_CN.trim(),
    occurredAt: parseKstDateTime(item.CREAT_DT),
    regionText: region || null,
    level: mapEmergencyLevel(item.EMRGNCY_STEP_NM),
    link: 'https://www.safekorea.go.kr/idsiSFK/neo/sfk/cs/sfc/dis/disasterMsgList.jsp?emgPage=Y&menuSeq=679',
    payload: buildPayload(item),
  };
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

const mapEmergencyLevel = (value: string): EventLevel => {
  if (value.includes('위급')) {
    return EventLevel.Critical;
  }
  if (value.includes('긴급')) {
    return EventLevel.Severe;
  }
  if (value.includes('안전')) {
    return EventLevel.Minor;
  }
  return EventLevel.Info;
};

const filterNewItems = (items: DisasterSmsItem[], lastSeenSerial: number | null): DisasterSmsItem[] => {
  if (lastSeenSerial === null) {
    return items;
  }

  return items.filter((item) => item.MD101_SN > lastSeenSerial);
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

const fetchWithTimeout = async (url: string, init: RequestInit): Promise<Response | null> => {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  try {
    const response = await fetch(url, { ...init, signal: controller.signal });
    if (!response.ok) {
      logger.warn({ status: response.status }, 'Disaster SMS request failed');
      return null;
    }

    return response;
  } catch (error) {
    logger.warn({ error }, 'Disaster SMS request error');
    return null;
  } finally {
    clearTimeout(timeout);
  }
};

const parseJsonResponse = async (response: Response, sourceId: string): Promise<unknown | null> => {
  try {
    const text = await response.text();
    return JSON.parse(text) as unknown;
  } catch (error) {
    logger.warn({ error, sourceId }, 'Failed to decode disaster SMS response');
    return null;
  }
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
