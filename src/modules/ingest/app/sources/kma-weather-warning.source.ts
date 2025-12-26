import iconv from 'iconv-lite';
import { env } from '@/core/env';
import { logger } from '@/core/logger';
import type { EventPayload } from '@/modules/events/domain/entity/event.entity';
import { EventKinds, EventLevels, EventSources } from '@/modules/events/domain/event.enums';
import type { Source, SourceEvent, SourceRunResult } from '../../domain/port/source.interface';

const KMA_WARNING_ENDPOINT = 'https://apihub.kma.go.kr/api/typ01/url/wrn_now_data_new.php';
const REQUEST_TIMEOUT_MS = 30000;
const STATE_TTL_MS = 1000 * 60 * 60 * 24 * 7;

const WARNING_KIND_BY_NAME: Record<string, EventKinds> = {
  강풍: EventKinds.Wind,
  호우: EventKinds.Rain,
  한파: EventKinds.Cold,
  건조: EventKinds.Dry,
  해일: EventKinds.Tsunami,
  지진해일: EventKinds.Tsunami,
  풍랑: EventKinds.HighSeas,
  태풍: EventKinds.Typhoon,
  대설: EventKinds.Snow,
  황사: EventKinds.YellowDust,
  폭염: EventKinds.Heat,
  안개: EventKinds.Fog,
};

const WARNING_LEVEL_BY_NAME: Record<string, EventLevels> = {
  예비: EventLevels.Minor,
  예비특보: EventLevels.Minor,
  주의: EventLevels.Moderate,
  주의보: EventLevels.Moderate,
  경보: EventLevels.Severe,
};

type WarningRow = {
  regUp: string;
  regUpKo: string;
  regId: string;
  regKo: string;
  tmFc: string;
  tmEf: string;
  wrn: string;
  lvl: string;
  cmd: string;
  edTm: string | null;
};

type WarningGroup = {
  regUp: string;
  regUpKo: string | null;
  regIds: string[];
  regKos: string[];
  tmFc: string;
  tmEf: string;
  wrn: string;
  lvl: string;
  cmd: string | null;
  edTm: string | null;
};

type WarningState = {
  seen: Record<string, string>;
};

export class KmaWeatherWarningSource implements Source {
  public readonly sourceId = EventSources.KmaWeatherWarning;
  public readonly pollIntervalSec = 60 * 5;

  public async run(state: string | null): Promise<SourceRunResult> {
    const authKey = env.KMA_API_KEY;
    if (!authKey) {
      logger.error('KMA weather warning auth key is missing');
      return { events: [], nextState: state };
    }

    const response = await fetchWithTimeout(buildRequestUrl(authKey));
    if (!response) {
      return { events: [], nextState: state };
    }

    const text = await decodeEucKrResponse(response);
    const rows = parseWarningRows(text);
    const groups = groupWarningRows(rows);

    const previousState = parseState(state);
    const seen = new Map<string, string>(Object.entries(previousState.seen));
    const now = new Date();
    const nowIso = now.toISOString();
    const nowMs = now.getTime();

    const events: SourceEvent[] = [];
    for (const group of groups) {
      const key = buildGroupKey(group.regUp, group.tmFc, group.tmEf, group.wrn, group.lvl, group.cmd);
      if (!seen.has(key)) {
        events.push(buildWarningEvent(group));
      }
      seen.set(key, nowIso);
    }

    pruneSeen(seen, nowMs);
    const nextState = buildState(seen);

    return { events, nextState };
  }
}

const buildWarningEvent = (group: WarningGroup): SourceEvent => {
  const regUpKo = normalizeOptionalText(group.regUpKo) ?? '';
  const kindLabel = normalizeWarningKindLabel(group.wrn);
  const levelLabel = normalizeWarningLevelLabel(group.lvl);
  const commandLabel = normalizeWarningCommandLabel(group.cmd);

  return {
    kind: mapWarningKind(kindLabel),
    title: buildTitle(regUpKo, kindLabel, levelLabel, commandLabel),
    body: buildBody(group.regKos, group.tmEf, group.edTm),
    occurredAt: parseKstCompactTimestamp(group.tmFc),
    regionText: buildRegionText(regUpKo, group.regKos),
    level: mapWarningLevel(levelLabel),
    payload: buildPayload(group, kindLabel, levelLabel, commandLabel),
  };
};

const buildTitle = (regUpKo: string, kind: string, level: string, command: string | null): string => {
  const parts = [normalizeOptionalText(regUpKo), normalizeOptionalText(kind), normalizeOptionalText(level), command]
    .filter((value): value is string => Boolean(value))
    .map((value) => value.trim());

  return parts.length > 0 ? parts.join(' ') : '기상 특보';
};

const buildBody = (regKos: string[], tmEf: string, edTm: string | null): string | null => {
  const lines: string[] = [];

  const effectiveAt = formatKstCompactTimestamp(tmEf);
  if (effectiveAt) {
    lines.push(`발효 시각: ${effectiveAt}`);
  }

  const normalized = normalizeOptionalText(edTm);
  if (normalized) {
    lines.push(`해제예고: ${normalized}`);
  }

  const regions = regKos
    .map((region) => normalizeOptionalText(region))
    .filter((region): region is string => Boolean(region));
  if (regions.length > 0) {
    lines.push(`상세 지역: ${regions.join(', ')}`);
  }

  return lines.length > 0 ? lines.join('\n') : null;
};

const buildPayload = (
  group: WarningGroup,
  kindLabel: string,
  levelLabel: string,
  commandLabel: string | null,
): EventPayload => {
  return {
    regUp: group.regUp,
    regUpKo: group.regUpKo,
    regIds: group.regIds,
    regKos: group.regKos,
    tmFc: group.tmFc,
    tmEf: group.tmEf,
    wrn: group.wrn,
    wrnLabel: kindLabel,
    lvl: group.lvl,
    lvlLabel: levelLabel,
    cmd: group.cmd,
    cmdLabel: commandLabel,
    edTm: group.edTm,
  };
};

const mapWarningKind = (value: string): EventKinds => {
  const normalized = normalizeWarningKindLabel(value);
  return WARNING_KIND_BY_NAME[normalized] ?? EventKinds.Other;
};

const mapWarningLevel = (value: string): EventLevels => {
  const normalized = normalizeWarningLevelLabel(value);
  return WARNING_LEVEL_BY_NAME[normalized] ?? EventLevels.Info;
};

const normalizeWarningKindLabel = (value: string): string => {
  return normalizeText(value);
};

const normalizeWarningLevelLabel = (value: string): string => {
  return normalizeText(value);
};

const normalizeWarningCommandLabel = (value: string | null): string | null => {
  return normalizeOptionalText(value);
};

const buildRegionText = (regUpKo: string, regKos: string[]): string | null => {
  const base = normalizeOptionalText(regUpKo);
  const uniqueRegions: string[] = [];

  for (const item of regKos) {
    const normalized = normalizeOptionalText(item);
    if (!normalized) {
      continue;
    }
    if (!uniqueRegions.includes(normalized)) {
      uniqueRegions.push(normalized);
    }
  }

  const prefixed = uniqueRegions.map((region) => (base ? `${base} ${region}` : region));
  if (prefixed.length > 0) {
    return prefixed.join(', ');
  }

  return base;
};

const parseWarningRows = (text: string): WarningRow[] => {
  const normalizedText = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  const lines = normalizedText.split('\n');
  const rows: WarningRow[] = [];

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) {
      continue;
    }

    const cells = line.split(',').map((cell) => normalizeText(cell));
    const trimmedCells = trimTrailingCells(cells);

    if (trimmedCells.length < 9) {
      continue;
    }

    const [regUp, regUpKo, regId, regKo, tmFc, tmEf, wrn, lvl, cmd, edTm] = trimmedCells;
    if (!regUp || regUp === 'REG_UP') {
      continue;
    }

    rows.push({
      regUp,
      regUpKo,
      regId,
      regKo,
      tmFc,
      tmEf,
      wrn,
      lvl,
      cmd,
      edTm: edTm ?? null,
    });
  }

  return rows;
};

const trimTrailingCells = (cells: string[]): string[] => {
  let end = cells.length;
  while (end > 0) {
    const value = cells[end - 1];
    if (value === '' || value === '=') {
      end -= 1;
      continue;
    }
    break;
  }
  return cells.slice(0, end);
};

const groupWarningRows = (rows: WarningRow[]): WarningGroup[] => {
  const groups = new Map<string, WarningGroup>();

  for (const row of rows) {
    const key = buildGroupKey(row.regUp, row.tmFc, row.tmEf, row.wrn, row.lvl, row.cmd);
    let group = groups.get(key);
    if (!group) {
      group = {
        regUp: normalizeText(row.regUp),
        regUpKo: normalizeOptionalText(row.regUpKo),
        regIds: [],
        regKos: [],
        tmFc: normalizeText(row.tmFc),
        tmEf: normalizeText(row.tmEf),
        wrn: normalizeText(row.wrn),
        lvl: normalizeText(row.lvl),
        cmd: normalizeOptionalText(row.cmd),
        edTm: normalizeOptionalText(row.edTm),
      };
      groups.set(key, group);
    }

    if (!group.regUpKo) {
      group.regUpKo = normalizeOptionalText(row.regUpKo);
    }
    if (!group.cmd) {
      group.cmd = normalizeOptionalText(row.cmd);
    }
    if (!group.edTm) {
      group.edTm = normalizeOptionalText(row.edTm);
    }

    const regId = normalizeOptionalText(row.regId);
    if (regId && !group.regIds.includes(regId)) {
      group.regIds.push(regId);
    }

    const regKo = normalizeOptionalText(row.regKo);
    if (regKo && !group.regKos.includes(regKo)) {
      group.regKos.push(regKo);
    }
  }

  return [...groups.values()];
};

const buildGroupKey = (
  regUp: string,
  tmFc: string,
  tmEf: string,
  wrn: string,
  lvl: string,
  cmd: string | null,
): string => {
  return [
    normalizeKeyPart(regUp),
    normalizeKeyPart(tmFc),
    normalizeKeyPart(tmEf),
    normalizeKeyPart(wrn),
    normalizeKeyPart(lvl),
    normalizeKeyPart(cmd ?? ''),
  ].join('|');
};

const normalizeKeyPart = (value: string): string => {
  return normalizeText(value).toUpperCase();
};

const parseState = (state: string | null): WarningState => {
  if (!state) {
    return { seen: {} };
  }

  try {
    const parsed = JSON.parse(state) as { seen?: unknown };
    if (!parsed.seen || typeof parsed.seen !== 'object' || Array.isArray(parsed.seen)) {
      return { seen: {} };
    }

    const seen: Record<string, string> = {};
    for (const [key, value] of Object.entries(parsed.seen as Record<string, unknown>)) {
      if (typeof value === 'string') {
        seen[key] = value;
      }
    }

    return { seen };
  } catch (error) {
    logger.warn({ error }, 'Failed to parse KMA warning checkpoint state');
    return { seen: {} };
  }
};

const buildState = (seen: Map<string, string>): string | null => {
  if (seen.size === 0) {
    return null;
  }

  return JSON.stringify({ seen: Object.fromEntries(seen) });
};

const pruneSeen = (seen: Map<string, string>, nowMs: number): void => {
  for (const [key, value] of seen) {
    const parsed = Date.parse(value);
    if (!Number.isFinite(parsed)) {
      seen.delete(key);
      continue;
    }

    if (nowMs - parsed > STATE_TTL_MS) {
      seen.delete(key);
    }
  }
};

const normalizeText = (value: string): string => {
  return value.replace(/\s+/g, ' ').trim();
};

const normalizeOptionalText = (value: string | null | undefined): string | null => {
  if (!value) {
    return null;
  }
  const normalized = normalizeText(value);
  return normalized.length > 0 ? normalized : null;
};

const parseKstCompactTimestamp = (value: string): string | null => {
  const matched = value.match(/^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})$/);
  if (!matched) {
    return null;
  }

  const [, year, month, day, hour, minute] = matched;
  const utcMs = Date.UTC(Number(year), Number(month) - 1, Number(day), Number(hour) - 9, Number(minute), 0);
  const date = new Date(utcMs);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
};

const formatKstCompactTimestamp = (value: string): string | null => {
  const matched = value.match(/^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})$/);
  if (!matched) {
    return normalizeOptionalText(value);
  }

  const [, year, month, day, hour, minute] = matched;
  return `${year}-${month}-${day} ${hour}:${minute} KST`;
};

const buildRequestUrl = (authKey: string): string => {
  const url = new URL(KMA_WARNING_ENDPOINT);
  url.search = new URLSearchParams({
    fe: 'f',
    tm: '',
    disp: '0',
    help: '0',
    authKey,
  }).toString();
  return url.toString();
};

const fetchWithTimeout = async (url: string): Promise<Response | null> => {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  try {
    const response = await fetch(url, { signal: controller.signal });
    if (!response.ok) {
      logger.warn({ status: response.status }, 'KMA weather warning request failed');
      return null;
    }

    return response;
  } catch (error) {
    logger.warn(error, 'KMA weather warning request error');
    return null;
  } finally {
    clearTimeout(timeout);
  }
};

const decodeEucKrResponse = async (response: Response): Promise<string> => {
  const buffer = Buffer.from(await response.arrayBuffer());
  return iconv.decode(buffer, 'euc-kr');
};
