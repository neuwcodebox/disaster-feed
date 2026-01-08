import { afterEach, describe, expect, it, vi } from 'vitest';
import { EventKinds } from '@/modules/events/domain/event.enums';
import { KmaPewsEarthquakeSource } from './kma-pews-earthquake.source';

const buildBits = (value: number, length: number): string => value.toString(2).padStart(length, '0');

const buildPewsBinary = (options: {
  latitude: number;
  longitude: number;
  magnitude: number;
  depthKm: number;
  unixSeconds: number;
  eqkIdRaw: number;
  intensity: number;
  maxAreaBits: string;
  infoText: string;
}): Uint8Array => {
  const latRaw = Math.round((options.latitude - 30) * 100);
  const lonRaw = Math.round((options.longitude - 124) * 100);
  const magRaw = Math.round(options.magnitude * 10);
  const depRaw = Math.round(options.depthKm * 10);

  const bits = [
    buildBits(latRaw, 10),
    buildBits(lonRaw, 10),
    buildBits(magRaw, 7),
    buildBits(depRaw, 10),
    buildBits(options.unixSeconds, 32),
    buildBits(options.eqkIdRaw, 26),
    buildBits(options.intensity, 4),
    options.maxAreaBits.padEnd(17, '0').slice(0, 17),
  ].join('');

  const infoBitsBytes = new Uint8Array(15);
  for (let i = 0; i < infoBitsBytes.length; i += 1) {
    const start = i * 8;
    const segment = bits.slice(start, start + 8).padEnd(8, '0');
    infoBitsBytes[i] = Number.parseInt(segment, 2);
  }

  const infoTextBytes = new Uint8Array(60);
  const encoded = new TextEncoder().encode(options.infoText);
  infoTextBytes.set(encoded.slice(0, infoTextBytes.length));

  const header = new Uint8Array([0b01000000, 0, 0, 0]);
  const payload = new Uint8Array(header.length + infoBitsBytes.length + infoTextBytes.length);
  payload.set(header, 0);
  payload.set(infoBitsBytes, header.length);
  payload.set(infoTextBytes, header.length + infoBitsBytes.length);

  return payload;
};

describe('KmaPewsEarthquakeSource', () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('should parse binary payload and build earthquake event', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2025-01-02T00:00:00.000Z'));

    const unixSeconds = Math.floor(new Date('2025-01-02T00:00:00.000Z').getTime() / 1000);
    const binary = buildPewsBinary({
      latitude: 37.5,
      longitude: 127.0,
      magnitude: 5.1,
      depthKm: 10,
      unixSeconds,
      eqkIdRaw: 250102,
      intensity: 5,
      maxAreaBits: '10000000000000000',
      infoText: '서울 지역',
    });

    const buffer = binary.slice().buffer;
    const fetchMock = vi
      .fn()
      .mockImplementation(() =>
        Promise.resolve(new Response(buffer, { status: 200, headers: { 'Content-Type': 'application/octet-stream' } })),
      );
    vi.stubGlobal('fetch', fetchMock);

    const source = new KmaPewsEarthquakeSource();
    const result = await source.run(null);

    expect(result.events).toHaveLength(1);
    expect(result.events[0].kind).toBe(EventKinds.Quake);
    expect(result.events[0].title).toContain('규모 5.1');
    expect(result.events[0].title).toContain('지진 신속정보');
    expect(result.events[0].regionText).toBe('서울 지역');
  });
});
