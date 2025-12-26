import { type Cheerio, load } from 'cheerio';
import type { AnyNode } from 'domhandler';
import iconv from 'iconv-lite';
import { Agent, fetch, type Response } from 'undici';
import { logger } from '@/core/logger';
import type { EventPayload } from '@/modules/events/domain/entity/event.entity';
import { EventKinds, EventLevels, EventSources } from '@/modules/events/domain/event.enums';
import type { Source, SourceEvent, SourceRunResult } from '../../domain/port/source.interface';

const UTIC_INCIDENT_ENDPOINT = 'https://www.utic.go.kr/tsdms/incident.do';
const REQUEST_TIMEOUT_MS = 20000;
const STATE_TTL_MS = 1000 * 60 * 60 * 6;
const EVENT_MAX_AGE_MS = STATE_TTL_MS * 0.9;
const INSECURE_DISPATCHER = new Agent({ connect: { rejectUnauthorized: false } });
let loggedInsecure = false;

const COMMON_INCIDENT_TYPE = '{"사고":"","공사":"none","행사":"none","기상":"","통제":"","재난":"","기타":"none"}';

const GRADE_QUERY: Record<IncidentGrade, string> = {
  A: '{"사고":"A0401","기상":"A0401","통제":"A0401","재난":"A0401"}',
  B: '{"사고":"A0402","기상":"A0402","통제":"A0402","재난":"A0402"}',
  C: '{"사고":"A0403","기상":"A0403","통제":"A0403","재난":"A0403"}',
};

const KIND_BY_LABEL: Record<string, EventKinds> = {
  사고: EventKinds.Transport,
  통제: EventKinds.Transport,
  공사: EventKinds.Transport,
  행사: EventKinds.Transport,
  기상: EventKinds.Transport,
  재난: EventKinds.Transport,
  기타: EventKinds.Transport,
};

type IncidentGrade = 'A' | 'B' | 'C';

type IncidentItem = {
  title: string;
  body: string | null;
  occurredAt: string | null;
  rawDateText: string | null;
  label: string | null;
  incidentId: string | null;
  mapType: string | null;
  coordX: string | null;
  coordY: string | null;
};

type TrafficIncidentState = {
  seen: Record<string, string>;
};

export class UticTrafficIncidentSource implements Source {
  public readonly sourceId = EventSources.UticTrafficIncident;
  public readonly pollIntervalSec = 60;

  public async run(state: string | null): Promise<SourceRunResult> {
    const previousState = parseState(state);
    const seen = new Map<string, string>(Object.entries(previousState.seen));
    const now = new Date();
    const nowMs = now.getTime();
    const nowIso = now.toISOString();

    const events: SourceEvent[] = [];

    const grades: IncidentGrade[] = ['A', 'B', 'C'];
    for (const grade of grades) {
      const response = await fetchWithTimeout(buildRequestUrl(grade));
      if (!response) {
        continue;
      }

      const html = await decodeHtmlResponse(response);
      if (!html) {
        continue;
      }

      const items = parseIncidentItems(html);
      for (const item of items) {
        if (isTooOld(item.occurredAt, nowMs)) {
          continue;
        }
        const key = buildUniqueKey(item, grade);
        if (shouldEmitEvent(seen.get(key), nowMs)) {
          events.push(buildEvent(item, grade));
        }
        seen.set(key, nowIso);
      }
    }

    pruneSeen(seen, nowMs);
    const nextState = buildState(seen);

    return { events, nextState };
  }
}

const buildEvent = (item: IncidentItem, grade: IncidentGrade): SourceEvent => {
  return {
    kind: mapIncidentKind(item.label),
    title: item.title,
    body: item.body,
    occurredAt: item.occurredAt,
    regionText: null,
    level: mapGradeLevel(grade),
    payload: buildPayload(item, grade),
  };
};

const mapIncidentKind = (label: string | null): EventKinds => {
  if (!label) {
    return EventKinds.Transport;
  }

  return KIND_BY_LABEL[label] ?? EventKinds.Transport;
};

const mapGradeLevel = (grade: IncidentGrade): EventLevels => {
  if (grade === 'A') {
    return EventLevels.Minor;
  }
  return EventLevels.Info;
};

const buildPayload = (item: IncidentItem, grade: IncidentGrade): EventPayload => {
  return {
    incidentId: item.incidentId,
    mapType: item.mapType,
    coordX: item.coordX,
    coordY: item.coordY,
    grade,
    label: item.label,
    rawDateText: item.rawDateText,
  };
};

const parseIncidentItems = (html: string): IncidentItem[] => {
  const $ = load(html);
  const items: IncidentItem[] = [];
  const listItems = $('.data-box > ul > li').toArray();

  for (const element of listItems) {
    const container = $(element).find('.result_box');
    const dateNode = container.find('p.date').first();
    const dateText = extractDateText(dateNode);
    const { incidentId, mapType, coordX, coordY } = parseMapLink(dateNode);

    const bodyText = normalizeText(container.find('p').not('.date').first().text());
    if (!bodyText) {
      continue;
    }

    const { title, body } = splitTitleBody(bodyText);

    items.push({
      title,
      body,
      occurredAt: parseKstDateText(dateText),
      rawDateText: dateText,
      label: extractIncidentLabel(bodyText),
      incidentId,
      mapType,
      coordX,
      coordY,
    });
  }

  return items;
};

const extractDateText = (node: Cheerio<AnyNode>): string | null => {
  if (node.length === 0) {
    return null;
  }

  const cloned = node.clone();
  cloned.find('a').remove();
  const text = normalizeText(cloned.text());
  return text || null;
};

const parseMapLink = (
  node: Cheerio<AnyNode>,
): { incidentId: string | null; mapType: string | null; coordX: string | null; coordY: string | null } => {
  const href = node.find('a').attr('href') ?? '';
  const matched = href.match(/gotoMapIncident\('([^']*)','([^']*)','([^']*)','([^']*)'\)/);
  if (!matched) {
    return {
      incidentId: null,
      mapType: null,
      coordX: null,
      coordY: null,
    };
  }

  const [, incidentId, mapType, coordX, coordY] = matched;
  return {
    incidentId: normalizeOptionalText(incidentId),
    mapType: normalizeOptionalText(mapType),
    coordX: normalizeOptionalText(coordX),
    coordY: normalizeOptionalText(coordY),
  };
};

const extractIncidentLabel = (text: string): string | null => {
  const matched = text.match(/^<([^>]+)>/);
  if (!matched) {
    return null;
  }

  const label = normalizeText(matched[1]);
  return label || null;
};

const splitTitleBody = (text: string): { title: string; body: string | null } => {
  const cleaned = text.trim();
  if (!cleaned) {
    return { title: cleaned, body: null };
  }

  const separator = ' - ';
  const index = cleaned.indexOf(separator);
  if (index < 0) {
    return splitBySentence(cleaned);
  }

  const title = cleaned.slice(0, index).trim();
  const body = cleaned.slice(index + separator.length).trim();
  if (!title || !body) {
    return { title: cleaned, body: null };
  }

  if (title.length < 8) {
    return { title: cleaned, body: null };
  }

  return { title, body };
};

const splitBySentence = (text: string): { title: string; body: string | null } => {
  const firstPeriod = text.indexOf('.');
  if (firstPeriod < 0) {
    return { title: text, body: null };
  }

  const title = text.slice(0, firstPeriod + 1).trim();
  const body = text.slice(firstPeriod + 1).trim();
  if (!title) {
    return { title: text, body: null };
  }

  if (title.length < 8) {
    return { title: text, body: null };
  }

  return { title, body: body.length > 0 ? body : null };
};

const parseKstDateText = (value: string | null): string | null => {
  if (!value) {
    return null;
  }

  const matched = value.match(/^(\d{4})\s*년\s*(\d{1,2})\s*월\s*(\d{1,2})\s*일\s*(\d{1,2})\s*시\s*(\d{1,2})\s*분$/);
  if (!matched) {
    return null;
  }

  const [, year, month, day, hour, minute] = matched;
  const monthText = String(Number(month)).padStart(2, '0');
  const dayText = String(Number(day)).padStart(2, '0');
  const hourText = String(Number(hour)).padStart(2, '0');
  const minuteText = String(Number(minute)).padStart(2, '0');
  const kstIso = `${year}-${monthText}-${dayText}T${hourText}:${minuteText}:00+09:00`;
  const parsed = new Date(kstIso);
  if (Number.isNaN(parsed.getTime())) {
    return null;
  }

  return parsed.toISOString();
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

const buildUniqueKey = (item: IncidentItem, grade: IncidentGrade): string => {
  if (item.incidentId) {
    return `${item.incidentId}:${grade}`;
  }

  const titleKey = normalizeKeyPart(item.title);
  const timeKey = normalizeKeyPart(item.occurredAt ?? '');
  return `${grade}:${titleKey}:${timeKey}`;
};

const normalizeKeyPart = (value: string): string => {
  return normalizeText(value).toUpperCase();
};

const parseState = (state: string | null): TrafficIncidentState => {
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
    for (const [key, value] of Object.entries(rawSeen as Record<string, unknown>)) {
      const trimmedKey = key.trim();
      if (trimmedKey && typeof value === 'string') {
        seen[trimmedKey] = value;
      }
    }

    return { seen };
  } catch (error) {
    logger.warn({ error }, 'Failed to parse UTIC traffic incident checkpoint state');
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

const isTooOld = (occurredAt: string | null, nowMs: number): boolean => {
  if (!occurredAt) {
    return false;
  }

  const parsed = Date.parse(occurredAt);
  if (!Number.isFinite(parsed)) {
    return false;
  }

  return nowMs - parsed > EVENT_MAX_AGE_MS;
};

const buildRequestUrl = (grade: IncidentGrade): string => {
  const url = new URL(UTIC_INCIDENT_ENDPOINT);
  url.search = new URLSearchParams({
    incident_type: COMMON_INCIDENT_TYPE,
    accident_gubun: GRADE_QUERY[grade],
    hideDamagedRoad: 'true',
  }).toString();
  return url.toString();
};

const decodeHtmlResponse = async (response: Response): Promise<string | null> => {
  try {
    const buffer = Buffer.from(await response.arrayBuffer());
    const contentType = response.headers.get('content-type') ?? '';
    const encoding = resolveEncoding(contentType);
    return iconv.decode(buffer, encoding);
  } catch (error) {
    logger.warn({ error }, 'Failed to decode UTIC traffic incident response');
    return null;
  }
};

const resolveEncoding = (contentType: string): string => {
  const lower = contentType.toLowerCase();
  if (lower.includes('euc-kr') || lower.includes('ks_c_5601-1987')) {
    return 'euc-kr';
  }
  return 'utf-8';
};

const fetchWithTimeout = async (url: string): Promise<Response | null> => {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  try {
    if (!loggedInsecure) {
      logger.warn('UTIC TLS certificate verification disabled for UTIC source');
      loggedInsecure = true;
    }

    const response = await fetch(url, {
      signal: controller.signal,
      dispatcher: INSECURE_DISPATCHER,
      headers: {
        'User-Agent': 'Mozilla/5.0',
      },
    });
    if (!response.ok) {
      logger.warn({ status: response.status }, 'UTIC traffic incident request failed');
      return null;
    }

    return response;
  } catch (error) {
    logger.warn(error, 'UTIC traffic incident request error');
    return null;
  } finally {
    clearTimeout(timeout);
  }
};
