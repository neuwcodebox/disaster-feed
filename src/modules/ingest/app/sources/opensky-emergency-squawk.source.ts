import { z } from 'zod';
import { env } from '@/core/env';
import { logger } from '@/core/logger';
import { EventKinds, EventLevels, EventSources } from '@/modules/events/domain/event.enums';
import type { Source, SourceEvent, SourceRunResult } from '../../domain/port/source.interface';
import { fetchWithTimeout } from './_shared/fetch-with-timeout';
import { isTooOld } from './_shared/is-too-old';
import { normalizeText } from './_shared/normalize';
import { pruneTimedMap } from './_shared/prune-timed-map';
import { shouldEmitEvent } from './_shared/should-emit-event';

const OPENSKY_TOKEN_ENDPOINT =
  'https://auth.opensky-network.org/auth/realms/opensky-network/protocol/openid-connect/token';
const OPENSKY_STATES_ENDPOINT =
  'https://opensky-network.org/api/states/all?lamin=32.90284330827965&lamax=38.70294554565657&lomin=125.54418240072219&lomax=129.84176310720568';
const REQUEST_TIMEOUT_MS = 20000;
const TOKEN_DEFAULT_TTL_SEC = 60 * 30;
const TOKEN_SAFETY_WINDOW_MS = 1000 * 60;
const STATE_TTL_MS = 1000 * 60 * 60 * 24;
const EVENT_MAX_AGE_MS = 1000 * 60 * 30;

const EMERGENCY_SQUAWK_LABELS: Record<string, string> = {
  '7500': '하이재킹',
  '7600': '통신장애',
  '7700': '비상사태',
};

const schemaTokenResponse = z.object({
  access_token: z.string().min(1),
  expires_in: z.number().int().positive().optional(),
});

const schemaStatesResponse = z.object({
  time: z.number().int(),
  states: z.array(z.array(z.unknown())).nullable(),
});

type TokenState = {
  accessToken: string;
  expiresAt: string;
};

type OpenSkyState = {
  seen: Record<string, string>;
};

type OpenSkyStateVector = {
  icao24: string;
  callsign: string | null;
  originCountry: string | null;
  timePosition: number | null;
  lastContact: number | null;
  longitude: number | null;
  latitude: number | null;
  baroAltitude: number | null;
  onGround: boolean | null;
  velocity: number | null;
  trueTrack: number | null;
  verticalRate: number | null;
  sensors: number[] | null;
  geoAltitude: number | null;
  squawk: string | null;
  spi: boolean | null;
  positionSource: number | null;
};

export class OpenSkyEmergencySquawkSource implements Source {
  public readonly sourceId = EventSources.OpenSkyEmergencySquawk;
  public readonly pollIntervalSec = 60 * 5;

  private tokenState: TokenState | null = null;

  public async run(state: string | null): Promise<SourceRunResult> {
    const clientId = env.OPENSKY_CLIENT_ID;
    const clientSecret = env.OPENSKY_CLIENT_SECRET;
    if (!clientId || !clientSecret) {
      logger.error('OpenSky client credentials are missing');
      throw new Error('OpenSky client credentials are missing');
    }

    const previousState = parseState(state);
    const seen = new Map<string, string>(Object.entries(previousState.seen));
    const now = new Date();
    const nowMs = now.getTime();
    const nowIso = now.toISOString();

    let tokenState = this.tokenState;
    if (!isTokenValid(tokenState, nowMs)) {
      tokenState = await issueToken(clientId, clientSecret, nowMs);
      this.tokenState = tokenState;
    }
    if (!tokenState) {
      throw new Error('OpenSky token is missing');
    }

    let statesResponse = await fetchStates(tokenState.accessToken);
    if (!statesResponse) {
      throw new Error('OpenSky states request failed');
    }

    if (statesResponse.status === 401) {
      tokenState = await issueToken(clientId, clientSecret, nowMs);
      this.tokenState = tokenState;
      statesResponse = await fetchStates(tokenState.accessToken);
      if (!statesResponse) {
        throw new Error('OpenSky states request failed after token refresh');
      }
    }

    if (!statesResponse.ok) {
      throw new Error(`OpenSky states request failed: ${statesResponse.status}`);
    }

    const payload = await statesResponse.json();
    const parsed = schemaStatesResponse.safeParse(payload);
    if (!parsed.success) {
      logger.warn({ error: parsed.error }, 'Failed to parse OpenSky states response');
      throw new Error('Failed to parse OpenSky states response');
    }

    const responseTime = parsed.data.time;
    const rows = parsed.data.states ?? [];
    const events: SourceEvent[] = [];

    for (const rawRow of rows) {
      const row = parseStateVector(rawRow);
      if (!row) {
        continue;
      }

      const squawk = row.squawk;
      if (!squawk || !EMERGENCY_SQUAWK_LABELS[squawk]) {
        continue;
      }

      const occurredAt = resolveOccurredAt(row, responseTime);
      if (isTooOld(occurredAt, nowMs, EVENT_MAX_AGE_MS)) {
        continue;
      }

      const key = buildDedupKey(row.icao24, squawk);
      if (shouldEmitEvent(seen.get(key), nowMs, STATE_TTL_MS)) {
        events.push(buildEvent(row, squawk, occurredAt));
      }
      seen.set(key, nowIso);
    }

    pruneTimedMap(seen, nowMs, STATE_TTL_MS);
    const nextState = buildState(seen);

    return { events, nextState };
  }
}

async function issueToken(clientId: string, clientSecret: string, nowMs: number): Promise<TokenState> {
  const body = new URLSearchParams({
    grant_type: 'client_credentials',
    client_id: clientId,
    client_secret: clientSecret,
  });

  const response = await fetchWithTimeout({
    url: OPENSKY_TOKEN_ENDPOINT,
    init: {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: body.toString(),
    },
    timeoutMs: REQUEST_TIMEOUT_MS,
    allowNonOk: true,
  });

  if (!response) {
    throw new Error('OpenSky token request failed');
  }

  if (!response.ok) {
    throw new Error(`OpenSky token request failed: ${response.status}`);
  }

  const payload = await response.json();
  const parsed = schemaTokenResponse.safeParse(payload);
  if (!parsed.success) {
    logger.warn({ error: parsed.error }, 'Failed to parse OpenSky token response');
    throw new Error('Failed to parse OpenSky token response');
  }

  const expiresInSec = parsed.data.expires_in ?? TOKEN_DEFAULT_TTL_SEC;
  const expiresAt = new Date(nowMs + expiresInSec * 1000).toISOString();

  return { accessToken: parsed.data.access_token, expiresAt };
}

async function fetchStates(accessToken: string): Promise<Response | null> {
  return fetchWithTimeout({
    url: OPENSKY_STATES_ENDPOINT,
    init: {
      headers: {
        Authorization: `Bearer ${accessToken}`,
      },
    },
    timeoutMs: REQUEST_TIMEOUT_MS,
    allowNonOk: true,
  });
}

function buildEvent(row: OpenSkyStateVector, squawk: string, occurredAt: string | null): SourceEvent {
  const callsign = row.callsign ?? row.icao24;
  const label = EMERGENCY_SQUAWK_LABELS[squawk] ?? squawk;

  return {
    kind: EventKinds.Transport,
    title: `한국 상공 ${callsign}편 ${squawk}(${label}) 선언`,
    body: buildBody(row),
    occurredAt,
    geo: resolveGeo(row),
    level: resolveLevel(squawk),
    payload: row,
  };
}

function buildBody(row: OpenSkyStateVector): string | null {
  const lines: string[] = [];

  if (row.originCountry) {
    lines.push(`국적: ${row.originCountry}`);
  }

  const altitudeLine = buildAltitudeLine(row);
  if (altitudeLine) {
    lines.push(altitudeLine);
  }

  const flightLine = buildFlightLine(row);
  if (flightLine) {
    lines.push(flightLine);
  }

  if (lines.length === 0) {
    return null;
  }

  return lines.join('\n');
}

function buildAltitudeLine(row: OpenSkyStateVector): string | null {
  const altitudeParts: string[] = [];
  const baroAltitude = formatMeters(row.baroAltitude);
  if (baroAltitude) {
    altitudeParts.push(`기압고도 ${baroAltitude}`);
  }

  const geoAltitude = formatMeters(row.geoAltitude);
  if (geoAltitude) {
    altitudeParts.push(`지오고도 ${geoAltitude}`);
  }

  if (altitudeParts.length === 0) {
    return null;
  }

  let suffix = '';
  if (row.onGround !== null) {
    suffix = ` (${row.onGround ? '지상' : '공중'})`;
  }

  return `고도: ${altitudeParts.join(' / ')}${suffix}`;
}

function buildFlightLine(row: OpenSkyStateVector): string | null {
  const parts: string[] = [];

  const speed = formatSpeed(row.velocity);
  if (speed) {
    parts.push(`속도 ${speed}`);
  }

  const track = formatDegrees(row.trueTrack);
  if (track) {
    parts.push(`진로 ${track}`);
  }

  const verticalRate = formatRate(row.verticalRate);
  if (verticalRate) {
    parts.push(`상승률 ${verticalRate}`);
  }

  if (parts.length === 0) {
    return null;
  }

  return `비행: ${parts.join(', ')}`;
}

function resolveGeo(row: OpenSkyStateVector): { lat: number; lng: number } | null {
  if (row.latitude === null || row.longitude === null) {
    return null;
  }

  return { lat: row.latitude, lng: row.longitude };
}

function resolveLevel(squawk: string): EventLevels {
  if (squawk === '7500') {
    return EventLevels.Severe;
  }
  if (squawk === '7700') {
    return EventLevels.Moderate;
  }
  if (squawk === '7600') {
    return EventLevels.Minor;
  }
  return EventLevels.Info;
}

function resolveOccurredAt(row: OpenSkyStateVector, responseTime: number): string | null {
  const timestamp = row.lastContact ?? row.timePosition ?? responseTime;
  if (!Number.isFinite(timestamp) || timestamp <= 0) {
    return null;
  }

  return new Date(timestamp * 1000).toISOString();
}

function buildDedupKey(icao24: string, squawk: string): string {
  return `${icao24}_${squawk}`;
}

function isTokenValid(token: TokenState | null, nowMs: number): boolean {
  if (!token) {
    return false;
  }

  const expiresAtMs = Date.parse(token.expiresAt);
  if (!Number.isFinite(expiresAtMs)) {
    return false;
  }

  return nowMs + TOKEN_SAFETY_WINDOW_MS < expiresAtMs;
}

function parseState(state: string | null): OpenSkyState {
  if (!state) {
    return { seen: {} };
  }

  try {
    const parsed = JSON.parse(state) as { seen?: unknown };
    if (!parsed || typeof parsed !== 'object') {
      return { seen: {} };
    }

    const seen = parseSeenState(parsed.seen);

    return { seen };
  } catch (error) {
    logger.warn({ error }, 'Failed to parse OpenSky state checkpoint');
    return { seen: {} };
  }
}

function parseSeenState(value: unknown): Record<string, string> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return {};
  }

  const seen: Record<string, string> = {};
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    const trimmedKey = key.trim();
    if (!trimmedKey || typeof entry !== 'string') {
      continue;
    }
    seen[trimmedKey] = entry;
  }

  return seen;
}

function buildState(seen: Map<string, string>): string {
  const payload: Record<string, string> = {};
  for (const [key, value] of seen) {
    payload[key] = value;
  }

  return JSON.stringify({ seen: payload });
}

function parseStateVector(raw: unknown): OpenSkyStateVector | null {
  if (!Array.isArray(raw) || raw.length < 17) {
    return null;
  }

  const icao24 = parseText(raw[0]);
  if (!icao24) {
    return null;
  }

  return {
    icao24,
    callsign: parseText(raw[1]),
    originCountry: parseText(raw[2]),
    timePosition: parseNumber(raw[3]),
    lastContact: parseNumber(raw[4]),
    longitude: parseNumber(raw[5]),
    latitude: parseNumber(raw[6]),
    baroAltitude: parseNumber(raw[7]),
    onGround: parseBoolean(raw[8]),
    velocity: parseNumber(raw[9]),
    trueTrack: parseNumber(raw[10]),
    verticalRate: parseNumber(raw[11]),
    sensors: parseNumberArray(raw[12]),
    geoAltitude: parseNumber(raw[13]),
    squawk: parseText(raw[14]),
    spi: parseBoolean(raw[15]),
    positionSource: parseNumber(raw[16]),
  };
}

function parseText(value: unknown): string | null {
  if (typeof value !== 'string') {
    return null;
  }

  return normalizeText(value);
}

function parseNumber(value: unknown): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return null;
  }

  return value;
}

function parseBoolean(value: unknown): boolean | null {
  if (typeof value !== 'boolean') {
    return null;
  }

  return value;
}

function parseNumberArray(value: unknown): number[] | null {
  if (!Array.isArray(value)) {
    return null;
  }

  const numbers: number[] = [];
  for (const entry of value) {
    if (typeof entry === 'number' && Number.isFinite(entry)) {
      numbers.push(entry);
    }
  }

  return numbers.length > 0 ? numbers : null;
}

function formatMeters(value: number | null): string | null {
  if (value === null) {
    return null;
  }

  return `${Math.round(value)}m`;
}

function formatSpeed(value: number | null): string | null {
  if (value === null) {
    return null;
  }

  return `${Math.round(value)} m/s`;
}

function formatRate(value: number | null): string | null {
  if (value === null) {
    return null;
  }

  return `${Math.round(value * 10) / 10} m/s`;
}

function formatDegrees(value: number | null): string | null {
  if (value === null) {
    return null;
  }

  return `${Math.round(value)}°`;
}
