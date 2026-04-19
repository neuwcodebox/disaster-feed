import iconv from 'iconv-lite';
import { env } from '@/core/env';
import { logger } from '@/core/logger';
import type { EventPayload } from '@/modules/events/domain/entity/event.entity';
import { EventKinds, EventLevels, EventSources } from '@/modules/events/domain/event.enums';
import type { Source, SourceEvent, SourceRunResult } from '../../domain/port/source.interface';
import { type FetchResponse, fetchWithTimeout } from './_shared/fetch-with-timeout';
import { isTooOld } from './_shared/is-too-old';
import { normalizeText } from './_shared/normalize';
import { pruneTimedMap } from './_shared/prune-timed-map';

const KMA_WARNING_ENDPOINT = 'https://apihub.kma.go.kr/api/typ01/url/wrn_now_data_new.php';
const STATE_TTL_MS = 1000 * 60 * 60 * 24 * 6;
const EVENT_MAX_AGE_MS = STATE_TTL_MS * 0.9;

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
  예비: EventLevels.Info,
  예비특보: EventLevels.Info,
  주의: EventLevels.Minor,
  주의보: EventLevels.Minor,
  경보: EventLevels.Moderate,
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
      throw new Error('KMA weather warning auth key is missing');
    }

    const response = await fetchWithTimeout({
      url: buildRequestUrl(authKey),
      timeoutMs: 30000,
    });
    if (!response) {
      throw new Error('KMA weather warning request failed');
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
      const occurredAt = resolveOccurredAt(group.tmFc, nowMs);
      if (isTooOld(occurredAt, nowMs, EVENT_MAX_AGE_MS)) {
        continue;
      }
      const key = buildGroupKey(group.regUp, group.tmFc, group.tmEf, group.wrn, group.lvl, group.cmd);
      if (!seen.has(key)) {
        events.push(buildWarningEvent(group, occurredAt));
      }
      seen.set(key, nowIso);
    }

    pruneTimedMap(seen, nowMs, STATE_TTL_MS);
    const nextState = buildState(seen);

    return { events, nextState };
  }
}

const buildWarningEvent = (group: WarningGroup, occurredAt: string | null): SourceEvent => {
  const regUpKo = normalizeText(group.regUpKo) ?? '';
  const kindLabel = group.wrn.trim();
  const levelLabel = group.lvl.trim();
  const commandLabel = group.cmd?.trim() ?? null;

  return {
    kind: mapWarningKind(kindLabel),
    title: buildTitle(regUpKo, kindLabel, levelLabel, commandLabel),
    body: buildBody(group.regKos, group.tmEf, group.edTm),
    occurredAt,
    regionText: buildRegionText(regUpKo, group.regKos),
    level: mapWarningLevel(levelLabel),
    payload: buildPayload(group, kindLabel, levelLabel, commandLabel),
  };
};

const buildTitle = (regUpKo: string, kind: string, level: string, command: string | null): string => {
  const parts = [normalizeText(regUpKo), normalizeText(kind), normalizeText(level), command]
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

  const normalized = normalizeText(edTm);
  if (normalized) {
    lines.push(`해제예고: ${normalized}`);
  }

  const regions = regKos.map((region) => normalizeText(region)).filter((region): region is string => Boolean(region));
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
  const normalized = value.trim();
  return WARNING_KIND_BY_NAME[normalized] ?? EventKinds.Other;
};

const mapWarningLevel = (value: string): EventLevels => {
  const normalized = value.trim();
  return WARNING_LEVEL_BY_NAME[normalized] ?? EventLevels.Info;
};

const buildRegionText = (regUpKo: string, regKos: string[]): string | null => {
  const base = normalizeText(regUpKo);
  const uniqueRegions: string[] = [];

  for (const item of regKos) {
    const normalized = normalizeText(item);
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

    const cells = line.split(',').map((cell) => normalizeText(cell) ?? '');
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
        regUp: normalizeText(row.regUp) ?? '',
        regUpKo: normalizeText(row.regUpKo),
        regIds: [],
        regKos: [],
        tmFc: normalizeText(row.tmFc) ?? '',
        tmEf: normalizeText(row.tmEf) ?? '',
        wrn: normalizeText(row.wrn) ?? '',
        lvl: normalizeText(row.lvl) ?? '',
        cmd: normalizeText(row.cmd),
        edTm: normalizeText(row.edTm),
      };
      groups.set(key, group);
    }

    if (!group.regUpKo) {
      group.regUpKo = normalizeText(row.regUpKo);
    }
    if (!group.cmd) {
      group.cmd = normalizeText(row.cmd);
    }
    if (!group.edTm) {
      group.edTm = normalizeText(row.edTm);
    }

    const regId = normalizeText(row.regId);
    if (regId && !group.regIds.includes(regId)) {
      group.regIds.push(regId);
    }

    const regKo = normalizeText(row.regKo);
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
    normalizeText(regUp) ?? '',
    normalizeText(tmFc) ?? '',
    normalizeText(tmEf) ?? '',
    normalizeText(wrn) ?? '',
    normalizeText(lvl) ?? '',
    normalizeText(cmd ?? '') ?? '',
  ].join('|');
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

const buildState = (seen: Map<string, string>): string => {
  return JSON.stringify({ seen: Object.fromEntries(seen) });
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

const resolveOccurredAt = (tmFc: string, nowMs: number): string | null => {
  const forecastAt = parseKstCompactTimestamp(tmFc);
  if (!forecastAt) {
    return null;
  }

  const forecastAtMs = new Date(forecastAt).getTime();
  if (Number.isNaN(forecastAtMs)) {
    return null;
  }

  return new Date(Math.min(forecastAtMs, nowMs)).toISOString();
};

const formatKstCompactTimestamp = (value: string): string | null => {
  const matched = value.match(/^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})$/);
  if (!matched) {
    return normalizeText(value);
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

const decodeEucKrResponse = async (response: FetchResponse): Promise<string> => {
  const buffer = Buffer.from(await response.arrayBuffer());
  return iconv.decode(buffer, 'euc-kr');
};
