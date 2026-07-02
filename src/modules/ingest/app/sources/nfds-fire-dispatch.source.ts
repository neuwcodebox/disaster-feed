import { z } from 'zod';
import { logger } from '@/core/logger';
import type { EventGeo, EventPayload } from '@/modules/events/domain/entity/event.entity';
import { EventKinds, EventLevels, EventSources } from '@/modules/events/domain/event.enums';
import type { IRegionRepository, RegionCenter } from '../../domain/port/region-repo.interface';
import type { Source, SourceEvent, SourceRunResult } from '../../domain/port/source.interface';
import { fetchWithTimeout } from './_shared/fetch-with-timeout';
import { isTooOld } from './_shared/is-too-old';
import { normalizeNumber, normalizeText } from './_shared/normalize';
import { pruneTimedMap } from './_shared/prune-timed-map';
import { shouldEmitEvent } from './_shared/should-emit-event';

const NFDS_FIRE_DISPATCH_ENDPOINT = 'https://nfds.go.kr/dashboard/monitorData.do';
const STATE_TTL_MS = 1000 * 60 * 60 * 6;
const EVENT_MAX_AGE_MS = STATE_TTL_MS * 0.9;
const KST_OFFSET_MS = 9 * 60 * 60 * 1000;

const schemaFireDispatchDetailItem = z.object({
  sidoOvrNum: z.string().describe('예: "ZZ1147349386"'),
  progressStat: z.string().describe('예: "A"'),
  progressNm: z.string().optional().describe('예: "화재접수"'),
  cntrNm: z.string().optional().describe('예: "마포소방서"'),
  overDate: z.string().describe('예: "11:11"'),
  addr: z.string().describe('예: "서울특별시 마포구 상암동"'),
  sidoNm: z.string().optional().describe('예: "서울"'),
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
  defail: z.array(schemaFireDispatchDetailItem).optional().default([]),
  nowDate: z.string().optional().describe('예: "2025-12-26 11:11:31"'),
});

type FireDispatchDetailItem = z.infer<typeof schemaFireDispatchDetailItem>;

type FireDispatchState = {
  seen: Record<string, string>;
};

export class NfdsFireDispatchSource implements Source {
  public readonly sourceId = EventSources.NfdsFireDispatch;
  public readonly pollIntervalSec = 60;

  constructor(private readonly regionRepository: IRegionRepository) {}

  public async run(state: string | null): Promise<SourceRunResult> {
    const response = await fetchWithTimeout({
      url: NFDS_FIRE_DISPATCH_ENDPOINT,
      useInsecureTls: true,
      init: {
        headers: {
          Accept: 'application/json',
        },
      },
    });
    if (!response) {
      throw new Error('NFDS fire dispatch request failed');
    }

    const data = await response.json();

    const parsed = schemaFireDispatchResponse.safeParse(data);
    if (!parsed.success) {
      logger.warn({ error: parsed.error }, 'Failed to parse NFDS fire dispatch response');
      throw new Error('Failed to parse NFDS fire dispatch response');
    }

    const rawNfdsDate = parsed.data.nowDate ?? null;
    const nfdsDate = parseNowDate(rawNfdsDate);
    const now = new Date();
    const nowMs = now.getTime();
    const nowIso = now.toISOString();

    const previousState = parseState(state);
    const seen = new Map<string, string>(Object.entries(previousState.seen));
    const events: SourceEvent[] = [];

    for (const item of parsed.data.defail) {
      const occurredAt = parseOccurredAt(item.overDate, nfdsDate);
      if (isTooOld(occurredAt, nowMs, EVENT_MAX_AGE_MS)) {
        continue;
      }

      const key = buildUniqueKey(item);
      const lastSeen = seen.get(key);
      if (shouldEmitEvent(lastSeen, nowMs, STATE_TTL_MS)) {
        const isFirstIncident = !hasSeenIncident(seen, item.sidoOvrNum);
        const isProgressNotable = isNotableProgress(item.progressStat);
        if (isFirstIncident && isProgressNotable) {
          events.push(buildEvent(item, occurredAt, rawNfdsDate));
        }
      }
      seen.set(key, nowIso);
    }

    await attachRegionGeos(events, this.regionRepository);

    pruneTimedMap(seen, nowMs, STATE_TTL_MS);
    const nextState = buildState(seen);

    return { events, nextState };
  }
}

const buildEvent = (
  item: FireDispatchDetailItem,
  occurredAt: string | null,
  rawNowDate: string | null,
): SourceEvent => {
  const title = buildTitle(item.cntrNm, item.sidoNm, item.progressNm, item.frfalTypeCd);
  const regionText = buildRegionText(item.addr, item.sidoNm);
  const regionCodes = buildRegionCodes(item);

  return {
    kind: EventKinds.Fire,
    title,
    body: buildBody(item, regionText),
    occurredAt,
    regionText,
    regionCodes,
    level: EventLevels.Info,
    payload: buildPayload(item, rawNowDate),
  };
};

const buildTitle = (
  centerName: string | null | undefined,
  sidoName: string | null | undefined,
  progressName: string | null | undefined,
  frfalTypeCd: string | null | undefined,
): string => {
  const center = normalizeText(centerName) ?? buildFallbackCenterName(sidoName);
  const progress = normalizeText(progressName) ?? normalizeText(frfalTypeCd);

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
  const sido = normalizeText(sidoName);
  if (!sido) {
    return null;
  }

  return `${sido} 소방서`;
};

const buildBody = (item: FireDispatchDetailItem, regionText: string | null): string | null => {
  const lines: string[] = [];
  const address = regionText ?? normalizeText(item.addr);
  if (address) {
    lines.push(`주소: ${address}`);
  }

  const overDate = normalizeText(item.overDate);
  if (overDate) {
    lines.push(`접수 시각: ${overDate}`);
  }

  const type = normalizeText(item.frfalTypeCd);
  if (type) {
    lines.push(`처리: ${type}`);
  }

  const casualties = formatCasualties(normalizeNumber(item.dethNum), normalizeNumber(item.injuNum));
  if (casualties) {
    lines.push(`인명피해: ${casualties}`);
  }

  const expMount = normalizeText(item.expMount);
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

const buildPayload = (item: FireDispatchDetailItem, rawNowDate: string | null): EventPayload => {
  const lawSidoCd = normalizeLawSidoCode(item.lawSidoCd);

  return {
    sidoOvrNum: item.sidoOvrNum,
    investNo: normalizeText(item.investNo),
    cntrId: normalizeText(item.cntrId),
    sidoNm: normalizeText(item.sidoNm),
    cntrNm: normalizeText(item.cntrNm),
    overDate: normalizeText(item.overDate),
    progressStat: item.progressStat,
    progressNm: normalizeText(item.progressNm),
    frfalTypeCd: normalizeText(item.frfalTypeCd),
    addr: normalizeText(item.addr),
    marker: normalizeText(item.marker),
    dethNum: normalizeNumber(item.dethNum),
    injuNum: normalizeNumber(item.injuNum),
    expMount: normalizeText(item.expMount),
    lawSidoCd,
    lawGunguCd: normalizeText(item.lawGunguCd),
    lawDongCd: normalizeText(item.lawDongCd),
    lawRiCd: normalizeText(item.lawRiCd),
    nowDate: rawNowDate,
  };
};

const buildRegionCodes = (item: FireDispatchDetailItem): string[] | null => {
  const lawSidoCd = normalizeLawSidoCode(item.lawSidoCd);
  const lawGunguCd = normalizeLawCodePart(item.lawGunguCd, 3);
  const lawDongCd = normalizeLawCodePart(item.lawDongCd, 3);
  const lawRiCd = normalizeLawCodePart(item.lawRiCd, 2);

  if (!lawSidoCd || !lawGunguCd || !lawDongCd || !lawRiCd) {
    return null;
  }

  if (lawGunguCd === '000') {
    return null;
  }

  return [`${lawSidoCd}${lawGunguCd}${lawDongCd}${lawRiCd}`];
};

const normalizeLawCodePart = (value: string | null | undefined, length: number): string | null => {
  const normalized = normalizeText(value);
  if (!normalized) {
    return null;
  }
  return normalized.padStart(length, '0');
};

const normalizeLawSidoCode = (value: string | null | undefined): string | null => {
  const normalized = normalizeLawCodePart(value, 2);
  if (!normalized) {
    return null;
  }

  if (normalized === '42') {
    return '51';
  }

  if (normalized === '45') {
    return '52';
  }

  return normalized;
};

const buildRegionText = (addr: string, sidoNm: string | null | undefined): string | null => {
  const address = normalizeText(addr);
  if (address) {
    return address;
  }

  const sido = normalizeText(sidoNm);
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

const buildState = (seen: Map<string, string>): string => {
  const payload: Record<string, string> = {};
  for (const [key, value] of seen) {
    payload[key] = value;
  }

  return JSON.stringify({ seen: payload });
};

const REGION_CODE_PATTERN = /^\d{10}$/;
const MAX_PARENT_DEPTH = 2;

type RegionCandidateResult = {
  candidatesByCode: Map<string, string[]>;
  allCandidates: string[];
};

async function attachRegionGeos(events: SourceEvent[], regionRepository: IRegionRepository): Promise<void> {
  if (events.length === 0) {
    return;
  }

  const { candidatesByCode, allCandidates } = buildRegionCodeCandidates(events);
  if (allCandidates.length === 0) {
    return;
  }

  const centersByCode = await regionRepository.findCentersByCodes(allCandidates);
  for (const event of events) {
    const geo = resolveGeoForEvent(event.regionCodes, candidatesByCode, centersByCode);
    if (geo) {
      event.geo = geo;
    }
  }
}

function buildRegionCodeCandidates(events: SourceEvent[]): RegionCandidateResult {
  const candidatesByCode = new Map<string, string[]>();
  const allCandidates = new Set<string>();

  for (const event of events) {
    const regionCodes = event.regionCodes;
    if (!regionCodes) {
      continue;
    }

    for (const code of regionCodes) {
      if (candidatesByCode.has(code)) {
        continue;
      }

      const candidates = buildRegionCodeCandidateList(code);
      if (candidates.length === 0) {
        continue;
      }

      candidatesByCode.set(code, candidates);
      for (const candidate of candidates) {
        allCandidates.add(candidate);
      }
    }
  }

  return { candidatesByCode, allCandidates: Array.from(allCandidates) };
}

function resolveGeoForEvent(
  regionCodes: string[] | null | undefined,
  candidatesByCode: Map<string, string[]>,
  centersByCode: Map<string, RegionCenter>,
): EventGeo | null {
  if (!regionCodes) {
    return null;
  }

  for (const code of regionCodes) {
    const candidates = candidatesByCode.get(code);
    if (!candidates) {
      continue;
    }

    const geo = resolveGeoFromCandidates(candidates, centersByCode);
    if (geo) {
      return geo;
    }
  }

  return null;
}

function resolveGeoFromCandidates(candidates: string[], centersByCode: Map<string, RegionCenter>): EventGeo | null {
  for (const code of candidates) {
    const center = centersByCode.get(code);
    if (!center || center.centerLat === null || center.centerLng === null) {
      continue;
    }

    return { lat: center.centerLat, lng: center.centerLng };
  }

  return null;
}

function buildRegionCodeCandidateList(code: string): string[] {
  const normalized = normalizeRegionCode(code);
  if (!normalized) {
    return [];
  }

  const candidates: string[] = [normalized];
  let current = normalized;
  for (let depth = 0; depth < MAX_PARENT_DEPTH; depth += 1) {
    const parent = toParentRegionCode(current);
    if (!parent || parent === current) {
      break;
    }

    candidates.push(parent);
    current = parent;
  }

  return candidates;
}

function normalizeRegionCode(code: string): string | null {
  const trimmed = code.trim();
  if (!REGION_CODE_PATTERN.test(trimmed)) {
    return null;
  }

  return trimmed;
}

function toParentRegionCode(normalizedCode: string): string | null {
  const sido = normalizedCode.slice(0, 2);
  const gungu = normalizedCode.slice(2, 5);
  const dong = normalizedCode.slice(5, 8);
  const ri = normalizedCode.slice(8, 10);

  if (ri !== '00') {
    return `${sido}${gungu}${dong}00`;
  }

  if (dong !== '000') {
    return `${sido}${gungu}00000`;
  }

  return null;
}
