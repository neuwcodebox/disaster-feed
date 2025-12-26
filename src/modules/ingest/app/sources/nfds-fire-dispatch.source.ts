import { z } from 'zod';
import { logger } from '@/core/logger';
import type { EventPayload } from '@/modules/events/domain/entity/event.entity';
import { EventKinds, EventLevels, EventSources } from '@/modules/events/domain/event.enums';
import type { Source, SourceEvent, SourceRunResult } from '../../domain/port/source.interface';

const NFDS_FIRE_DISPATCH_ENDPOINT = 'https://nfds.go.kr/dashboard/monitorData.do';
const REQUEST_TIMEOUT_MS = 10000;
const STATE_TTL_MS = 1000 * 60 * 60 * 24;
const KST_OFFSET_MS = 9 * 60 * 60 * 1000;

const schemaFireDispatchMapItem = z.object({
  sidoOvrNum: z.string().describe('예: "ZZ4120786230"'),
  lawSidoCd: z.string().describe('예: "41"'),
  lawGunguCd: z.string().describe('예: "273"'),
});

const schemaFireDispatchDetailItem = z.object({
  sidoOvrNum: z.string().describe('예: "ZZ1147349386"'),
  progressStat: z.string().describe('예: "A"'),
  progressNm: z.string().optional().describe('예: "화재접수"'),
  cntrNm: z.string().optional().describe('예: "마포소방서"'),
  overDate: z.string().describe('예: "11:11"'),
  addr: z.string().describe('예: "서울특별시 마포구 상암동"'),
  sidoNm: z.string().describe('예: "서울"'),
  cntrId: z.string().optional().describe('예: "1136000"'),
  investNo: z.string().optional().describe('예: "251226010636669"'),
  lawSidoCd: z.string().optional().describe('예: "11"'),
  lawGunguCd: z.string().optional().describe('예: "440"'),
  lawDongCd: z.string().optional().describe('예: "127"'),
  lawRiCd: z.string().optional().describe('예: "00"'),
  marker: z.string().optional().describe('예: "marker1"'),
  frfalTypeCd: z.string().optional().describe('예: "자체진화"'),
  dethNum: z.coerce.number().int().optional().describe('예: 0'),
  injuNum: z.coerce.number().int().optional().describe('예: 0'),
  expMount: z.string().optional().describe('예: "-"'),
});

const schemaFireDispatchResponse = z.object({
  map: z.array(schemaFireDispatchMapItem).optional().default([]),
  defail: z.array(schemaFireDispatchDetailItem).optional().default([]),
  nowDate: z.string().optional().describe('예: "2025-12-26 11:11:31"'),
});

type FireDispatchMapItem = z.infer<typeof schemaFireDispatchMapItem>;
type FireDispatchDetailItem = z.infer<typeof schemaFireDispatchDetailItem>;

type FireDispatchState = {
  seen: Record<string, string>;
};

type MapCodes = {
  lawSidoCd: string;
  lawGunguCd: string;
};

export class NfdsFireDispatchSource implements Source {
  public readonly sourceId = EventSources.NfdsFireDispatch;
  public readonly pollIntervalSec = 60;

  public async run(state: string | null): Promise<SourceRunResult> {
    const response = await fetchWithTimeout(NFDS_FIRE_DISPATCH_ENDPOINT);
    if (!response) {
      return { events: [], nextState: state };
    }

    const data = await parseJsonResponse(response, this.sourceId);
    if (!data) {
      return { events: [], nextState: state };
    }

    const parsed = schemaFireDispatchResponse.safeParse(data);
    if (!parsed.success) {
      logger.warn({ error: parsed.error }, 'Failed to parse NFDS fire dispatch response');
      return { events: [], nextState: state };
    }

    const mapIndex = buildMapIndex(parsed.data.map);
    const rawNowDate = parsed.data.nowDate ?? null;
    const nowDate = parseNowDate(rawNowDate);
    const nowMs = nowDate ? nowDate.getTime() : Date.now();
    const nowIso = (nowDate ?? new Date()).toISOString();

    const previousState = parseState(state);
    const seen = new Map<string, string>(Object.entries(previousState.seen));
    const events: SourceEvent[] = [];

    for (const item of parsed.data.defail) {
      const key = buildUniqueKey(item);
      const lastSeen = seen.get(key);
      if (shouldEmitEvent(lastSeen, nowMs)) {
        const mapCodes = mapIndex.get(item.sidoOvrNum) ?? null;
        const isFirstIncident = !hasSeenIncident(seen, item.sidoOvrNum);
        const isProgressNotable = isNotableProgress(item.progressStat);
        if (isFirstIncident && isProgressNotable) {
          events.push(buildEvent(item, mapCodes, nowDate, rawNowDate));
        }
      }
      seen.set(key, nowIso);
    }

    pruneSeen(seen, nowMs);
    const nextState = buildState(seen);

    return { events, nextState };
  }
}

const buildEvent = (
  item: FireDispatchDetailItem,
  mapCodes: MapCodes | null,
  nowDate: Date | null,
  rawNowDate: string | null,
): SourceEvent => {
  const title = buildTitle(item.cntrNm, item.sidoNm, item.progressNm, item.frfalTypeCd);
  const regionText = buildRegionText(item.addr, item.sidoNm);
  const occurredAt = parseOccurredAt(item.overDate, nowDate);

  return {
    kind: EventKinds.Fire,
    title,
    body: buildBody(item, regionText),
    occurredAt,
    regionText,
    level: EventLevels.Info,
    payload: buildPayload(item, mapCodes, rawNowDate),
  };
};

const buildTitle = (
  centerName: string | null | undefined,
  sidoName: string | null | undefined,
  progressName: string | null | undefined,
  frfalTypeCd: string | null | undefined,
): string => {
  const center = normalizeOptionalString(centerName) ?? buildFallbackCenterName(sidoName);
  const progress = normalizeOptionalString(progressName) ?? normalizeOptionalString(frfalTypeCd);

  if (center && progress) {
    return `${center} ${progress}`;
  }

  if (center) {
    return center;
  }

  if (progress) {
    return progress;
  }

  return '화재 출동 현황';
};

const buildFallbackCenterName = (sidoName: string | null | undefined): string | null => {
  const sido = normalizeOptionalString(sidoName);
  if (!sido) {
    return null;
  }

  return `${sido} 소방서`;
};

const buildBody = (item: FireDispatchDetailItem, regionText: string | null): string | null => {
  const lines: string[] = [];
  const address = regionText ?? normalizeOptionalString(item.addr);
  if (address) {
    lines.push(`주소: ${address}`);
  }

  const overDate = normalizeOptionalString(item.overDate);
  if (overDate) {
    lines.push(`접수 시각: ${overDate}`);
  }

  const type = normalizeOptionalString(item.frfalTypeCd);
  if (type) {
    lines.push(`처리: ${type}`);
  }

  const casualties = formatCasualties(normalizeNumber(item.dethNum), normalizeNumber(item.injuNum));
  if (casualties) {
    lines.push(`인명피해: ${casualties}`);
  }

  const expMount = normalizeOptionalString(item.expMount);
  if (expMount) {
    lines.push(`재산피해: ${expMount}`);
  }

  return lines.length > 0 ? lines.join('\n') : null;
};

const formatCasualties = (deaths: number | null, injuries: number | null): string | null => {
  const dead = deaths ?? 0;
  const injured = injuries ?? 0;

  if (dead <= 0 && injured <= 0) {
    return null;
  }

  const parts: string[] = [];
  if (dead > 0) {
    parts.push(`사망 ${dead}명`);
  }
  if (injured > 0) {
    parts.push(`부상 ${injured}명`);
  }
  return parts.join(', ');
};

const buildPayload = (
  item: FireDispatchDetailItem,
  mapCodes: MapCodes | null,
  rawNowDate: string | null,
): EventPayload => {
  const { lawSidoCd, lawGunguCd } = resolveLawCodes(item, mapCodes);

  return {
    sidoOvrNum: item.sidoOvrNum,
    investNo: normalizeOptionalString(item.investNo),
    cntrId: normalizeOptionalString(item.cntrId),
    sidoNm: item.sidoNm.trim(),
    cntrNm: normalizeOptionalString(item.cntrNm),
    overDate: normalizeOptionalString(item.overDate),
    progressStat: item.progressStat,
    progressNm: normalizeOptionalString(item.progressNm),
    frfalTypeCd: normalizeOptionalString(item.frfalTypeCd),
    addr: normalizeOptionalString(item.addr),
    marker: normalizeOptionalString(item.marker),
    dethNum: normalizeNumber(item.dethNum),
    injuNum: normalizeNumber(item.injuNum),
    expMount: normalizeOptionalString(item.expMount),
    lawSidoCd,
    lawGunguCd,
    lawDongCd: normalizeOptionalString(item.lawDongCd),
    lawRiCd: normalizeOptionalString(item.lawRiCd),
    nowDate: rawNowDate,
  };
};

const resolveLawCodes = (
  item: FireDispatchDetailItem,
  mapCodes: MapCodes | null,
): { lawSidoCd: string | null; lawGunguCd: string | null } => {
  const detailSido = normalizeOptionalString(item.lawSidoCd);
  const detailGungu = normalizeOptionalString(item.lawGunguCd);
  const mapSido = mapCodes ? normalizeOptionalString(mapCodes.lawSidoCd) : null;
  const mapGungu = mapCodes ? normalizeOptionalString(mapCodes.lawGunguCd) : null;

  return {
    lawSidoCd: detailSido ?? mapSido,
    lawGunguCd: detailGungu ?? mapGungu,
  };
};

const buildRegionText = (addr: string, sidoNm: string): string | null => {
  const address = normalizeOptionalString(addr);
  if (address) {
    return address;
  }

  const sido = normalizeOptionalString(sidoNm);
  return sido ?? null;
};

const isNotableProgress = (progressStat: string): boolean => {
  const normalized = progressStat.trim().toUpperCase();
  return normalized === 'A' || normalized === 'B';
};

const buildUniqueKey = (item: FireDispatchDetailItem): string => {
  const id = item.sidoOvrNum.trim();
  const status = item.progressStat.trim();
  return `${id}:${status}`;
};

const hasSeenIncident = (seen: Map<string, string>, sidoOvrNum: string): boolean => {
  const id = sidoOvrNum.trim();
  if (!id) {
    return false;
  }

  const prefix = `${id}:`;
  for (const key of seen.keys()) {
    if (key.startsWith(prefix)) {
      return true;
    }
  }

  return false;
};

const buildMapIndex = (items: FireDispatchMapItem[]): Map<string, MapCodes> => {
  const index = new Map<string, MapCodes>();

  for (const item of items) {
    const key = item.sidoOvrNum.trim();
    if (!key) {
      continue;
    }
    index.set(key, {
      lawSidoCd: item.lawSidoCd.trim(),
      lawGunguCd: item.lawGunguCd.trim(),
    });
  }

  return index;
};

const parseNowDate = (value: string | null): Date | null => {
  if (!value) {
    return null;
  }

  const matched = value.match(/^(\d{4})-(\d{2})-(\d{2})\s+(\d{2}):(\d{2}):(\d{2})$/);
  if (!matched) {
    return null;
  }

  const [, year, month, day, hour, minute, second] = matched;
  const kstIso = `${year}-${month}-${day}T${hour}:${minute}:${second}+09:00`;
  const parsed = new Date(kstIso);
  if (Number.isNaN(parsed.getTime())) {
    return null;
  }

  return parsed;
};

const parseOccurredAt = (overDate: string, nowDate: Date | null): string | null => {
  const matched = overDate.match(/^(\d{2}):(\d{2})$/);
  if (!matched) {
    return null;
  }

  const [, hour, minute] = matched;
  const baseDate = nowDate ?? new Date();
  const { year, month, day } = getKstDateParts(baseDate);
  const kstIso = `${year}-${month}-${day}T${hour}:${minute}:00+09:00`;
  const parsed = new Date(kstIso);
  if (Number.isNaN(parsed.getTime())) {
    return null;
  }

  if (nowDate && parsed.getTime() > nowDate.getTime()) {
    const adjusted = new Date(parsed.getTime() - 24 * 60 * 60 * 1000);
    return adjusted.toISOString();
  }

  return parsed.toISOString();
};

const getKstDateParts = (date: Date): { year: number; month: string; day: string } => {
  const kst = new Date(date.getTime() + KST_OFFSET_MS);
  const year = kst.getUTCFullYear();
  const month = String(kst.getUTCMonth() + 1).padStart(2, '0');
  const day = String(kst.getUTCDate()).padStart(2, '0');
  return { year, month, day };
};

const normalizeOptionalString = (value: string | null | undefined): string | null => {
  if (!value) {
    return null;
  }

  const trimmed = value.trim();
  if (!trimmed || trimmed === '-') {
    return null;
  }

  return trimmed;
};

const normalizeNumber = (value: number | undefined): number | null => {
  if (value === undefined) {
    return null;
  }

  return Number.isFinite(value) ? value : null;
};

const shouldEmitEvent = (lastSeen: string | undefined, nowMs: number): boolean => {
  if (!lastSeen) {
    return true;
  }

  const parsed = Date.parse(lastSeen);
  if (!Number.isFinite(parsed)) {
    return true;
  }

  return nowMs - parsed > STATE_TTL_MS;
};

const pruneSeen = (seen: Map<string, string>, nowMs: number): void => {
  for (const [key, value] of seen) {
    const parsed = Date.parse(value);
    if (!Number.isFinite(parsed) || nowMs - parsed > STATE_TTL_MS) {
      seen.delete(key);
    }
  }
};

const parseState = (state: string | null): FireDispatchState => {
  if (!state) {
    return { seen: {} };
  }

  try {
    const parsed = JSON.parse(state) as { seen?: unknown };
    if (!parsed || typeof parsed !== 'object') {
      return { seen: {} };
    }

    const rawSeen = parsed.seen;
    if (!rawSeen || typeof rawSeen !== 'object') {
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
    logger.warn({ error }, 'Failed to parse NFDS fire dispatch checkpoint state');
    return { seen: {} };
  }
};

const buildState = (seen: Map<string, string>): string | null => {
  if (seen.size === 0) {
    return null;
  }

  const payload: Record<string, string> = {};
  for (const [key, value] of seen) {
    payload[key] = value;
  }

  return JSON.stringify({ seen: payload });
};

const parseJsonResponse = async (response: Response, sourceId: EventSources): Promise<unknown | null> => {
  try {
    const text = await response.text();
    return JSON.parse(text) as unknown;
  } catch (error) {
    logger.warn({ error, sourceId }, 'Failed to decode NFDS fire dispatch response');
    return null;
  }
};

const fetchWithTimeout = async (url: string): Promise<Response | null> => {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  try {
    const response = await fetch(url, {
      signal: controller.signal,
      headers: {
        Accept: 'application/json',
        'User-Agent': 'Mozilla/5.0',
      },
    });
    if (!response.ok) {
      logger.warn({ status: response.status }, 'NFDS fire dispatch request failed');
      return null;
    }

    return response;
  } catch (error) {
    logger.warn(error, 'NFDS fire dispatch request error');
    return null;
  } finally {
    clearTimeout(timeout);
  }
};
