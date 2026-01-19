import { type Cheerio, load } from 'cheerio';
import type { AnyNode } from 'domhandler';
import { Agent, fetch, type Response } from 'undici';
import { env } from '@/core/env';
import { logger } from '@/core/logger';
import { EventKinds, EventLevels, EventSources } from '@/modules/events/domain/event.enums';
import type { Source, SourceEvent, SourceRunResult } from '../../domain/port/source.interface';
import { isTooOld } from './_shared/is-too-old';
import { normalizeText } from './_shared/normalize';
import { pruneTimedMap } from './_shared/prune-timed-map';
import { shouldEmitEvent } from './_shared/should-emit-event';

const UTIC_INCIDENT_ENDPOINT = 'https://www.utic.go.kr/guide/imsOpenData.do';
const REQUEST_TIMEOUT_MS = 30000;
const STATE_TTL_MS = 1000 * 60 * 60 * 6;
const EVENT_MAX_AGE_MS = STATE_TTL_MS * 0.9;
const INSECURE_DISPATCHER = new Agent({ connect: { rejectUnauthorized: false } });

const ALLOWED_INCIDENT_TYPE_CODES = new Set(['1', '4', '5', '6']);

type UticIncidentItem = {
  incidentId: string | null;
  incidenteTypeCd: string | null;
  incidenteSubTypeCd: string | null;
  addressJibun: string | null;
  addressJibunCd: string | null;
  addressNew: string | null;
  linkId: string | null;
  locationDataX: string | null;
  locationDataY: string | null;
  locationTypeCd: string | null;
  locationData: string | null;
  incidenteTrafficCd: string | null;
  incidenteGradeCd: string | null;
  incidentTitle: string | null;
  incTrafficCode: string | null;
  incidentRegionCd: string | null;
  startDate: string | null;
  endDate: string | null;
  lane: string | null;
  roadName: string | null;
  sourceCode: string | null;
  lineLinkId: string | null;
  controlType: string | null;
  important: string | null;
  updateDate: string | null;
};

type TrafficIncidentState = {
  seen: Record<string, string>;
};

export class UticTrafficIncidentSource implements Source {
  public readonly sourceId = EventSources.UticTrafficIncident;
  public readonly pollIntervalSec = 60;

  public async run(state: string | null): Promise<SourceRunResult> {
    const authKey = env.UTIC_API_KEY;
    if (!authKey) {
      logger.error('UTIC traffic incident auth key is missing');
      throw new Error('UTIC traffic incident auth key is missing');
    }

    const previousState = parseState(state);
    const seen = new Map<string, string>(Object.entries(previousState.seen));
    const now = new Date();
    const nowMs = now.getTime();
    const nowIso = now.toISOString();

    const response = await fetchWithTimeout(buildRequestUrl(authKey));
    if (!response) {
      throw new Error('UTIC traffic incident request failed');
    }

    const xml = await response.text();
    if (!xml) {
      throw new Error('Failed to decode UTIC traffic incident response');
    }

    const items = parseIncidentItems(xml);
    const events: SourceEvent[] = [];

    for (const item of items) {
      if (!item.incidenteTypeCd || !ALLOWED_INCIDENT_TYPE_CODES.has(item.incidenteTypeCd)) {
        continue;
      }
      if (!item.incidentTitle) {
        continue;
      }

      const occurredAt = parseKstDateText(item.startDate);
      if (isTooOld(occurredAt, nowMs, EVENT_MAX_AGE_MS)) {
        continue;
      }

      const key = buildUniqueKey(item);
      if (shouldEmitEvent(seen.get(key), nowMs, STATE_TTL_MS)) {
        events.push(buildEvent(item, occurredAt));
      }
      seen.set(key, nowIso);
    }

    pruneTimedMap(seen, nowMs, STATE_TTL_MS);
    const nextState = buildState(seen);

    return { events, nextState };
  }
}

const buildEvent = (item: UticIncidentItem, occurredAt: string | null): SourceEvent => {
  const geo = resolveGeo(item);
  const titleText = item.incidentTitle ?? '';
  const { title, body } = splitTitleBody(titleText);
  const regionText = resolveRegionText(item);
  const regionCodes = buildRegionCodes(item.addressJibunCd);

  return {
    kind: EventKinds.Transport,
    title,
    body,
    occurredAt,
    regionText,
    geo,
    regionCodes,
    level: mapGradeLevel(item.incidenteGradeCd),
    payload: item,
  };
};

const mapGradeLevel = (gradeCode: string | null): EventLevels => {
  if (!gradeCode) {
    return EventLevels.Info;
  }

  if (gradeCode === 'A0401') {
    return EventLevels.Minor;
  }

  return EventLevels.Info;
};

const parseCoordinate = (value: string | null): number | null => {
  if (!value) {
    return null;
  }

  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
};

const resolveGeo = (item: UticIncidentItem): { lat: number; lng: number } | null => {
  const lng = parseCoordinate(item.locationDataX);
  const lat = parseCoordinate(item.locationDataY);

  if (lng === null || lat === null) {
    return null;
  }

  return { lat, lng };
};

const resolveRegionText = (item: UticIncidentItem): string | null => {
  return normalizeText(item.addressNew) ?? normalizeText(item.addressJibun);
};

const buildRegionCodes = (addressJibunCd: string | null): string[] | null => {
  const code = normalizeRegionCode(addressJibunCd);
  if (!code) {
    return null;
  }

  return [code];
};

const normalizeRegionCode = (value: string | null): string | null => {
  if (!value) {
    return null;
  }

  const digits = value.replace(/\D/g, '');
  if (digits.length !== 10) {
    return null;
  }

  return digits;
};

const parseIncidentItems = (xml: string): UticIncidentItem[] => {
  const $ = load(xml, { xmlMode: true });
  const items: UticIncidentItem[] = [];
  const records = $('record').toArray();

  for (const record of records) {
    const node = $(record);
    items.push({
      incidentId: getRecordText(node, ['incidentId']),
      incidenteTypeCd: getRecordText(node, ['incidenteTypeCd', 'incidentTypeCd']),
      incidenteSubTypeCd: getRecordText(node, ['incidenteSubTypeCd', 'incidentSubTypeCd']),
      addressJibun: getRecordText(node, ['addressJibun']),
      addressJibunCd: getRecordText(node, ['addressJibunCd']),
      addressNew: getRecordText(node, ['addressNew']),
      linkId: getRecordText(node, ['linkId']),
      locationDataX: getRecordText(node, ['locationDataX']),
      locationDataY: getRecordText(node, ['locationDataY']),
      locationTypeCd: getRecordText(node, ['locationTypeCd']),
      locationData: getRecordText(node, ['locationData']),
      incidenteTrafficCd: getRecordText(node, ['incidenteTrafficCd']),
      incidenteGradeCd: getRecordText(node, ['incidenteGradeCd']),
      incidentTitle: getRecordText(node, ['incidentTitle']),
      incTrafficCode: getRecordText(node, ['incTrafficCode']),
      incidentRegionCd: getRecordText(node, ['incidentRegionCd']),
      startDate: getRecordText(node, ['startDate']),
      endDate: getRecordText(node, ['endDate']),
      lane: getRecordText(node, ['lane']),
      roadName: getRecordText(node, ['roadName']),
      sourceCode: getRecordText(node, ['sourceCode']),
      lineLinkId: getRecordText(node, ['lineLinkId']),
      controlType: getRecordText(node, ['controlType']),
      important: getRecordText(node, ['important']),
      updateDate: getRecordText(node, ['updateDate']),
    });
  }

  return items;
};

const getRecordText = (node: Cheerio<AnyNode>, tags: string[]): string | null => {
  for (const tag of tags) {
    const text = normalizeText(node.find(tag).first().text());
    if (text) {
      return text;
    }
  }

  return null;
};

const splitTitleBody = (text: string): { title: string; body: string | null } => {
  const cleaned = text.trim();
  if (!cleaned) {
    return { title: cleaned, body: null };
  }

  const separator = ' / ';
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

const buildUniqueKey = (item: UticIncidentItem): string => {
  if (item.incidentId) {
    return item.incidentId;
  }

  const typeKey = normalizeText(item.incidenteTypeCd) ?? '';
  const titleKey = normalizeText(item.incidentTitle) ?? '';
  const timeKey = normalizeText(item.startDate) ?? '';
  return `${typeKey}:${titleKey}:${timeKey}`;
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

const buildRequestUrl = (authKey: string): string => {
  const url = new URL(UTIC_INCIDENT_ENDPOINT);
  url.search = new URLSearchParams({
    key: authKey,
  }).toString();
  return url.toString();
};

const fetchWithTimeout = async (url: string): Promise<Response | null> => {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  try {
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
