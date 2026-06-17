import { logger } from '@/core/logger';
import type { EventPayload } from '@/modules/events/domain/entity/event.entity';
import { EventKinds, EventLevels, EventSources } from '@/modules/events/domain/event.enums';
import type { Source, SourceEvent, SourceRunResult } from '../../domain/port/source.interface';
import { decodeHtmlEntities } from './_shared/decode-html-entities';
import { fetchWithTimeout } from './_shared/fetch-with-timeout';

const KMA_MICRO_EARTHQUAKE_ENDPOINT = 'https://www.weather.go.kr/w/wnuri-eqk-vol/eqk/eqk-micro.do';

type MicroEarthquakeDetail = {
  occurredAt: string | null;
  regionText: string | null;
  magnitude: number | null;
  depthKm: number | null;
};

export class KmaMicroEarthquakeSource implements Source {
  public readonly sourceId = EventSources.KmaMicroEarthquake;
  public readonly pollIntervalSec = 10;

  public async run(state: string | null): Promise<SourceRunResult> {
    const response = await fetchWithTimeout({ url: KMA_MICRO_EARTHQUAKE_ENDPOINT });
    if (!response) {
      throw new Error('KMA micro earthquake request failed');
    }

    const html = await response.text();
    const extracted = extractMicroEarthquakeText(html);
    if (!extracted) {
      logger.warn('Failed to extract micro earthquake text');
      throw new Error('Failed to extract micro earthquake text');
    }

    if (state && extracted === state) {
      return { events: [], nextState: state };
    }

    return {
      events: [buildMicroEarthquakeEvent(extracted)],
      nextState: extracted,
    };
  }
}

const buildMicroEarthquakeEvent = (text: string): SourceEvent => {
  const { header, detailLine } = splitHeaderAndDetail(text);
  const detail = detailLine ? parseMicroEarthquakeDetail(detailLine) : null;
  const title = buildTitle(header, detail?.regionText ?? null, detail?.magnitude ?? null);

  const body = detailLine ?? text;

  return {
    kind: EventKinds.Quake,
    title,
    body,
    occurredAt: detail?.occurredAt ?? null,
    regionText: detail?.regionText ?? null,
    level: EventLevels.Info,
    payload: buildPayload(text, detail, detailLine),
  };
};

const buildTitle = (header: string | null, regionText: string | null, magnitude: number | null): string => {
  const parts: string[] = [];

  if (regionText) {
    parts.push(regionText);
  }

  if (magnitude !== null) {
    parts.push(`규모 ${formatMagnitude(magnitude)}`);
  }

  if (parts.length === 0) {
    return header ? stripBracket(header) : '미소지진 발생 현황';
  }

  return `${parts.join(' ')} 미소지진`;
};

const formatMagnitude = (value: number): string => {
  return value.toFixed(1);
};

const buildPayload = (text: string, detail: MicroEarthquakeDetail | null, detailLine: string | null): EventPayload => {
  return {
    rawText: text,
    detailLine,
    occurredAt: detail?.occurredAt ?? null,
    regionText: detail?.regionText ?? null,
    magnitude: detail?.magnitude ?? null,
    depthKm: detail?.depthKm ?? null,
  };
};

const splitHeaderAndDetail = (text: string): { header: string | null; detailLine: string | null } => {
  const lines = text
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0);

  if (lines.length === 0) {
    return { header: null, detailLine: null };
  }

  if (lines.length === 1) {
    return { header: null, detailLine: lines[0] };
  }

  const [header, ...rest] = lines;
  return { header, detailLine: rest.join(' ') };
};

const parseMicroEarthquakeDetail = (detailLine: string): MicroEarthquakeDetail => {
  const occurredAt = parseKstDateTime(detailLine);
  const magnitude = extractMagnitude(detailLine);
  const depthKm = extractDepthKm(detailLine);
  const regionText = extractRegionText(detailLine);

  return {
    occurredAt,
    regionText,
    magnitude,
    depthKm,
  };
};

const extractMagnitude = (text: string): number | null => {
  const matched = text.match(/규모\s*:\s*([0-9.]+)/);
  if (!matched) {
    return null;
  }

  return parseNumber(matched[1]);
};

const extractDepthKm = (text: string): number | null => {
  const matched = text.match(/깊이\s*:\s*([0-9.]+)\s*km/);
  if (!matched) {
    return null;
  }

  return parseNumber(matched[1]);
};

const extractRegionText = (text: string): string | null => {
  const regionMatch = text.match(/(\d{4}\/\d{2}\/\d{2}\s+\d{2}:\d{2}:\d{2})\s+(.+?)(?:\s*\(|$)/);
  if (regionMatch) {
    const region = regionMatch[2].trim();
    return region.length > 0 ? region : null;
  }

  const fallback = text.replace(/\(.*?\)/g, '');
  const cleaned = fallback.replace(/\s+/g, ' ').trim();
  if (!cleaned) {
    return null;
  }

  const withoutTime = cleaned.replace(/^\d{4}\/\d{2}\/\d{2}\s+\d{2}:\d{2}:\d{2}\s*/, '');
  return withoutTime.length > 0 ? withoutTime : null;
};

const parseNumber = (value: string): number | null => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
};

const stripBracket = (value: string): string => {
  const trimmed = value.trim();
  if (trimmed.startsWith('[') && trimmed.endsWith(']')) {
    return trimmed.slice(1, -1).trim();
  }
  return trimmed;
};

const extractMicroEarthquakeText = (html: string): string | null => {
  const content = sanitizeHtmlFragment(html);
  if (!content.includes('미소지진')) {
    return null;
  }
  return content.length > 0 ? content : null;
};

const sanitizeHtmlFragment = (fragment: string): string => {
  let text = fragment.replace(/<br\s*\/?>/gi, '\n');
  text = text.replace(/<[^>]+>/g, '');
  text = decodeHtmlEntities(text);
  return text.replace(/\r\n/g, '\n').replace(/\r/g, '\n').trim();
};

const parseKstDateTime = (value: string): string | null => {
  const matched = value.match(/(\d{4})[./-](\d{2})[./-](\d{2})\s+(\d{2}):(\d{2}):(\d{2})/);
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
