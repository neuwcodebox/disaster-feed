import { logger } from '@/core/logger';
import type { EventPayload } from '@/modules/events/domain/entity/event.entity';
import { EventKinds, EventLevels, EventSources } from '@/modules/events/domain/event.enums';
import type { Source, SourceEvent, SourceRunResult } from '../../domain/port/source.interface';

const KMA_PEWS_ENDPOINT = 'https://www.weather.go.kr/pews/data';
const REQUEST_TIMEOUT_MS = 10000;
const DEFAULT_HEADER_LENGTH_BYTES = 4;
const SIMULATION_HEADER_LENGTH_BYTES = 1;
const INFO_TEXT_BYTES = 60;
const INFO_BITS_LENGTH = 120;
const INFO_BITS_BYTES = INFO_BITS_LENGTH / 8;
const INFO_BLOCK_BYTES = INFO_TEXT_BYTES + INFO_BITS_BYTES;
const KST_OFFSET_SEC = 9 * 60 * 60;
const KST_OFFSET_MS = KST_OFFSET_SEC * 1000;
const MAX_REASONABLE_TIME_DIFF_MS = 1000 * 60 * 60 * 24 * 30;
const SIMULATION_WINDOW_MS = 5 * 60 * 1000;
const ENV_SIM_EQK_ID = 'KMA_PEWS_SIM_EQK_ID';
const ENV_SIM_START_AT = 'KMA_PEWS_SIM_START_AT';

const AREA_NAMES = [
  '서울',
  '부산',
  '대구',
  '인천',
  '광주',
  '대전',
  '울산',
  '세종',
  '경기',
  '강원',
  '충북',
  '충남',
  '전북',
  '전남',
  '경북',
  '경남',
  '제주',
];

type PewsState = {
  lastEqkId: string | null;
  lastPhase: number | null;
};

type ParsedEarthquakeInfo = {
  eqkId: string | null;
  magnitude: number | null;
  depthKm: number | null;
  intensity: number | null;
  maxAreas: string[];
  occurredAt: string | null;
  infoText: string | null;
  latitude: number | null;
  longitude: number | null;
  rawUnixTime: number | null;
};

export class KmaPewsEarthquakeSource implements Source {
  public readonly sourceId = EventSources.KmaPewsEarthquake;
  public readonly pollIntervalSec = 2;
  private timeOffsetMs = 1000;
  private baseUrl = KMA_PEWS_ENDPOINT;
  private headerLengthBytes = DEFAULT_HEADER_LENGTH_BYTES;
  private simEndUtcMs: number | null = null;
  private simMode = false;

  public constructor() {
    this.configureSimulation();
  }

  public async run(state: string | null): Promise<SourceRunResult> {
    const parsedState = parseState(state);
    if (this.simMode && this.simEndUtcMs !== null) {
      const simulatedTimeMs = Date.now() - this.timeOffsetMs;
      if (simulatedTimeMs >= this.simEndUtcMs) {
        this.stopSimulation();
        return { events: [], nextState: state };
      }
    }

    const binTime = new Date(Date.now() - this.timeOffsetMs);
    const binTimeStr = formatUtcTimestamp(binTime);

    const response = await fetchWithTimeout(`${this.baseUrl}/${binTimeStr}.b`);
    if (!response) {
      return { events: [], nextState: state };
    }

    if (!this.simMode) {
      this.timeOffsetMs = updateOffsetFromHeaders(response.headers, this.timeOffsetMs);
    }

    if (!response.ok) {
      logger.warn({ status: response.status }, 'PEWS binary request failed');
      return { events: [], nextState: state };
    }

    const bytes = new Uint8Array(await response.arrayBuffer());
    if (bytes.length < this.headerLengthBytes + INFO_BLOCK_BYTES) {
      logger.warn({ size: bytes.length }, 'PEWS binary payload too small');
      return { events: [], nextState: state };
    }

    const phase = parsePhase(bytes, this.headerLengthBytes);
    if (phase < 2) {
      return { events: [], nextState: state };
    }

    const info = parseEarthquakeInfo(bytes);
    if (!info) {
      logger.warn('Failed to parse PEWS earthquake info');
      return { events: [], nextState: state };
    }

    const previousAlarmId = buildAlarmId(parsedState.lastEqkId, parsedState.lastPhase);
    const currentAlarmId = buildAlarmId(info.eqkId, phase);
    if (currentAlarmId && previousAlarmId === currentAlarmId) {
      return { events: [], nextState: state };
    }

    const event = buildEarthquakeEvent(phase, info, parsedState.lastEqkId, parsedState.lastPhase, binTimeStr);
    const nextState = buildState({
      lastEqkId: info.eqkId ?? parsedState.lastEqkId,
      lastPhase: phase,
    });

    return {
      events: [event],
      nextState,
    };
  }

  private configureSimulation(): void {
    const config = parseSimulationConfig();
    if (!config) {
      return;
    }

    const startUtc = parseKstCompactTimestamp(config.startAt);
    if (!startUtc) {
      logger.warn({ startAt: config.startAt }, 'Invalid PEWS simulation start time');
      return;
    }

    const eqkId = normalizeEqkId(config.eqkId);
    if (!eqkId) {
      logger.warn({ eqkId: config.eqkId }, 'Invalid PEWS simulation earthquake id');
      return;
    }

    this.applySimulation(eqkId, startUtc);
  }

  private applySimulation(eqkId: string, startUtc: Date): void {
    this.simMode = true;
    this.baseUrl = `${KMA_PEWS_ENDPOINT}/${eqkId}`;
    this.headerLengthBytes = SIMULATION_HEADER_LENGTH_BYTES;
    this.timeOffsetMs = Date.now() - startUtc.getTime();
    this.simEndUtcMs = startUtc.getTime() + SIMULATION_WINDOW_MS;
    logger.info({ eqkId, startUtc: startUtc.toISOString() }, 'PEWS simulation enabled');
  }

  private stopSimulation(): void {
    if (!this.simMode) {
      return;
    }
    this.resetSimulation();
    logger.info('PEWS simulation finished');
  }

  private resetSimulation(): void {
    this.simMode = false;
    this.baseUrl = KMA_PEWS_ENDPOINT;
    this.headerLengthBytes = DEFAULT_HEADER_LENGTH_BYTES;
    this.timeOffsetMs = 1000;
    this.simEndUtcMs = null;
  }
}

const parseSimulationConfig = (): { eqkId: string; startAt: string } | null => {
  const eqkId = process.env[ENV_SIM_EQK_ID];
  const startAt = process.env[ENV_SIM_START_AT];

  if (!eqkId && !startAt) {
    return null;
  }

  if (!eqkId || !startAt) {
    logger.warn({ eqkId: eqkId ?? null, startAt: startAt ?? null }, 'PEWS simulation requires both env vars');
    return null;
  }

  return { eqkId, startAt };
};

const parseKstCompactTimestamp = (value: string): Date | null => {
  const matched = value.match(/^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})$/);
  if (!matched) {
    return null;
  }

  const [, year, month, day, hour, minute, second] = matched;
  const utcMs = Date.UTC(
    Number(year),
    Number(month) - 1,
    Number(day),
    Number(hour) - 9,
    Number(minute),
    Number(second),
  );
  const date = new Date(utcMs);
  return Number.isNaN(date.getTime()) ? null : date;
};

const normalizeEqkId = (value: string): string => {
  return value.trim();
};

const parseState = (state: string | null): PewsState => {
  if (!state) {
    return { lastEqkId: null, lastPhase: null };
  }

  try {
    const parsed = JSON.parse(state) as { lastEqkId?: unknown; lastPhase?: unknown };
    const lastEqkId = typeof parsed.lastEqkId === 'string' ? parsed.lastEqkId : null;
    const lastPhase = typeof parsed.lastPhase === 'number' ? parsed.lastPhase : null;
    return { lastEqkId, lastPhase };
  } catch (error) {
    logger.warn({ error }, 'Failed to parse PEWS checkpoint state');
    return { lastEqkId: null, lastPhase: null };
  }
};

const buildState = (state: PewsState): string | null => {
  if (!state.lastEqkId && state.lastPhase === null) {
    return null;
  }

  return JSON.stringify(state);
};

const parsePhase = (bytes: Uint8Array, headerLengthBytes: number): number => {
  const headerBits = bytesToBitString(bytes.subarray(0, headerLengthBytes));
  if (headerBits.length < 3) {
    return 0;
  }

  if (headerBits[1] === '0') {
    return 1;
  }

  if (headerBits[1] === '1' && headerBits[2] === '0') {
    return 2;
  }

  if (headerBits[2] === '1') {
    return 3;
  }

  return 0;
};

const buildAlarmId = (eqkId: string | null, phase: number | null): string | null => {
  if (!eqkId || phase === null) {
    return null;
  }

  return `${eqkId}-${phase}`;
};

const parseEarthquakeInfo = (bytes: Uint8Array): ParsedEarthquakeInfo | null => {
  if (bytes.length < INFO_BLOCK_BYTES) {
    return null;
  }

  const infoBlock = bytes.subarray(bytes.length - INFO_BLOCK_BYTES);
  const infoBits = bytesToBitString(infoBlock.subarray(0, INFO_BITS_BYTES));
  if (infoBits.length < 116) {
    return null;
  }

  const latRaw = parseBitsInt(infoBits, 0, 10);
  const lonRaw = parseBitsInt(infoBits, 10, 20);
  const magRaw = parseBitsInt(infoBits, 20, 27);
  const depRaw = parseBitsInt(infoBits, 27, 37);
  const unixRaw = parseBitsInt(infoBits, 37, 69);
  const eqkIdRaw = parseBitsInt(infoBits, 69, 95);
  const intensityRaw = parseBitsInt(infoBits, 95, 99);
  const maxAreaBits = infoBits.slice(99, 116);

  const latitude = latRaw !== null ? 30 + latRaw / 100 : null;
  const longitude = lonRaw !== null ? 124 + lonRaw / 100 : null;
  const magnitude = magRaw !== null ? magRaw / 10 : null;
  const depthKm = depRaw !== null ? depRaw / 10 : null;
  const occurredAt = unixRaw !== null ? parseUnixTimeToIso(unixRaw) : null;
  const eqkId = eqkIdRaw !== null ? `20${eqkIdRaw}` : null;
  const intensity = intensityRaw !== null ? intensityRaw : null;
  const maxAreas = parseMaxAreas(maxAreaBits);
  const infoText = decodeInfoText(infoBlock.subarray(INFO_BITS_BYTES));

  return {
    eqkId,
    magnitude,
    depthKm,
    intensity,
    maxAreas,
    occurredAt,
    infoText,
    latitude,
    longitude,
    rawUnixTime: unixRaw,
  };
};

const parseBitsInt = (bits: string, start: number, end: number): number | null => {
  if (bits.length < end) {
    return null;
  }

  const slice = bits.slice(start, end);
  if (!slice) {
    return null;
  }

  const parsed = Number.parseInt(slice, 2);
  return Number.isFinite(parsed) ? parsed : null;
};

const parseMaxAreas = (bits: string): string[] => {
  if (!bits || /^1+$/.test(bits)) {
    return [];
  }

  const areas: string[] = [];
  const limit = Math.min(bits.length, AREA_NAMES.length);
  for (let i = 0; i < limit; i += 1) {
    if (bits[i] === '1') {
      areas.push(AREA_NAMES[i]);
    }
  }

  return areas;
};

const decodeInfoText = (bytes: Uint8Array): string | null => {
  const decoder = new TextDecoder('utf-8');
  const raw = decoder.decode(bytes).replace(/\0/g, '').trim();
  if (!raw) {
    return null;
  }

  const normalized = raw.replace(/\+/g, ' ');
  const decoded = safeDecodeURIComponent(normalized);
  const cleaned = decoded.replace(/\s+/g, ' ').trim();
  return cleaned.length > 0 ? cleaned : null;
};

const safeDecodeURIComponent = (value: string): string => {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
};

const parseUnixTimeToIso = (seconds: number): string | null => {
  if (!Number.isFinite(seconds)) {
    return null;
  }

  const now = Date.now();
  const candidates = [seconds * 1000, (seconds - KST_OFFSET_SEC) * 1000, (seconds + KST_OFFSET_SEC) * 1000];

  let best = candidates[0];
  let bestDiff = Math.abs(best - now);
  for (let i = 1; i < candidates.length; i += 1) {
    const diff = Math.abs(candidates[i] - now);
    if (diff < bestDiff) {
      bestDiff = diff;
      best = candidates[i];
    }
  }

  if (bestDiff > MAX_REASONABLE_TIME_DIFF_MS) {
    best = seconds * 1000;
  }

  const date = new Date(best);
  if (Number.isNaN(date.getTime())) {
    return null;
  }

  return date.toISOString();
};

const buildEarthquakeEvent = (
  phase: number,
  info: ParsedEarthquakeInfo,
  previousEqkId: string | null,
  previousPhase: number | null,
  binTimeStr: string,
): SourceEvent => {
  const phaseLabel = phase === 2 ? '지진 신속정보' : '지진 상세정보';
  const title = buildTitle(phaseLabel, info);
  const body = buildBody(phaseLabel, info);

  return {
    kind: EventKinds.Quake,
    title,
    body,
    occurredAt: info.occurredAt,
    regionText: info.infoText ?? (info.maxAreas.length > 0 ? info.maxAreas.join(', ') : null),
    level: mapIntensityToLevel(info.intensity, phase, info.eqkId, previousPhase, previousEqkId),
    payload: buildPayload(phase, info, binTimeStr),
  };
};

const buildTitle = (phaseLabel: string, info: ParsedEarthquakeInfo): string => {
  const parts: string[] = [];
  if (info.infoText) {
    parts.push(info.infoText);
  }

  if (info.magnitude !== null) {
    parts.push(`규모 ${formatMagnitude(info.magnitude)}`);
  }

  if (parts.length === 0) {
    return phaseLabel;
  }

  return `${parts.join(' ')} ${phaseLabel}`;
};

const buildBody = (phaseLabel: string, info: ParsedEarthquakeInfo): string | null => {
  const lines: string[] = [];
  lines.push(phaseLabel);

  if (info.infoText) {
    lines.push(`정보 : ${info.infoText}`);
  }

  const occurredAtKst = info.occurredAt ? formatKstDateTime(info.occurredAt) : null;
  if (occurredAtKst) {
    lines.push(`발생 시각 : ${occurredAtKst}`);
  }

  if (info.magnitude !== null) {
    lines.push(`규모 : ${formatMagnitude(info.magnitude)}`);
  }

  if (info.depthKm !== null) {
    lines.push(`깊이 : ${formatDepthKm(info.depthKm)}`);
  }

  if (info.intensity !== null) {
    lines.push(`최대 진도 : ${info.intensity}`);
  }

  if (info.maxAreas.length > 0) {
    lines.push(`영향 지역 : ${info.maxAreas.join(', ')}`);
  }

  return lines.length > 0 ? lines.join('\n') : null;
};

const buildPayload = (phase: number, info: ParsedEarthquakeInfo, binTimeStr: string): EventPayload => {
  return {
    phase,
    binTime: binTimeStr,
    eqkId: info.eqkId,
    magnitude: info.magnitude,
    depthKm: info.depthKm,
    intensity: info.intensity,
    maxAreas: info.maxAreas,
    infoText: info.infoText,
    latitude: info.latitude,
    longitude: info.longitude,
    occurredAt: info.occurredAt,
    rawUnixTime: info.rawUnixTime,
  };
};

const formatMagnitude = (value: number): string => {
  return value.toFixed(1);
};

const formatDepthKm = (value: number): string => {
  if (value <= 0) {
    return '-';
  }

  return `${value.toFixed(1)} km`;
};

const mapIntensityToLevel = (
  intensity: number | null,
  phase: number,
  eqkId: string | null,
  previousPhase: number | null,
  previousEqkId: string | null,
): EventLevels => {
  // 같은 지진에 대해 이미 신속 정보가 발송된 경우, 상세 정보는 Info 레벨로 설정
  if (eqkId && previousEqkId && eqkId === previousEqkId && previousPhase === 2 && phase !== 2) {
    return EventLevels.Info;
  }

  if (intensity === null) {
    return phase === 2 ? EventLevels.Severe : EventLevels.Moderate;
  }

  if (phase === 2) {
    if (intensity >= 7) {
      return EventLevels.Critical;
    }
    if (intensity >= 5) {
      return EventLevels.Severe;
    }
    if (intensity >= 4) {
      return EventLevels.Moderate;
    }
    if (intensity >= 3) {
      return EventLevels.Minor;
    }
  } else {
    if (intensity >= 7) {
      return EventLevels.Severe;
    }
    if (intensity >= 5) {
      return EventLevels.Moderate;
    }
    if (intensity >= 4) {
      return EventLevels.Minor;
    }
  }

  return EventLevels.Info;
};

const formatKstDateTime = (iso: string): string | null => {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) {
    return null;
  }

  const kst = new Date(date.getTime() + KST_OFFSET_MS);
  const year = kst.getUTCFullYear();
  const month = String(kst.getUTCMonth() + 1).padStart(2, '0');
  const day = String(kst.getUTCDate()).padStart(2, '0');
  const hour = String(kst.getUTCHours()).padStart(2, '0');
  const minute = String(kst.getUTCMinutes()).padStart(2, '0');
  const second = String(kst.getUTCSeconds()).padStart(2, '0');
  return `${year}-${month}-${day} ${hour}:${minute}:${second}`;
};

const bytesToBitString = (bytes: Uint8Array): string => {
  let output = '';
  for (const value of bytes) {
    output += value.toString(2).padStart(8, '0');
  }
  return output;
};

const formatUtcTimestamp = (date: Date): string => {
  const year = date.getUTCFullYear();
  const month = String(date.getUTCMonth() + 1).padStart(2, '0');
  const day = String(date.getUTCDate()).padStart(2, '0');
  const hour = String(date.getUTCHours()).padStart(2, '0');
  const minute = String(date.getUTCMinutes()).padStart(2, '0');
  const second = String(date.getUTCSeconds()).padStart(2, '0');
  return `${year}${month}${day}${hour}${minute}${second}`;
};

const updateOffsetFromHeaders = (headers: Headers, fallbackOffsetMs: number): number => {
  const stHeader = headers.get('ST');
  if (stHeader) {
    const serverSeconds = Number.parseFloat(stHeader);
    if (Number.isFinite(serverSeconds)) {
      const offset = Date.now() - serverSeconds * 1000 + 1000;
      return Math.max(0, offset);
    }
  }

  const dateHeader = headers.get('Date');
  if (dateHeader) {
    const serverMs = Date.parse(dateHeader);
    if (Number.isFinite(serverMs)) {
      const offset = Date.now() - serverMs + 1000;
      return Math.max(0, offset);
    }
  }

  return fallbackOffsetMs;
};

const fetchWithTimeout = async (url: string): Promise<Response | null> => {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  try {
    return await fetch(url, {
      signal: controller.signal,
      headers: {
        'User-Agent': 'Mozilla/5.0',
      },
    });
  } catch (error) {
    logger.warn(error, 'PEWS request error');
    return null;
  } finally {
    clearTimeout(timeout);
  }
};
