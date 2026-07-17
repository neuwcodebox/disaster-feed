import iconv from 'iconv-lite';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { EventKinds, EventLevels } from '@/modules/events/domain/event.enums';

describe('KmaWeatherWarningSource', () => {
  afterEach(() => {
    delete process.env.KMA_API_KEY;
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('should parse warning rows and emit events', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2025-01-02T00:00:00.000Z'));

    process.env.KMA_API_KEY = 'test-key';
    vi.resetModules();
    const { KmaWeatherWarningSource } = await import('./kma-weather-warning.source');

    const csvText = ['11,서울,1111000000,서울특별시,202501020900,202501021200,호우,경보,발령,2025-01-02 18:00'].join(
      '\n',
    );

    const encoded = iconv.encode(csvText, 'euc-kr');
    const buffer = encoded.buffer.slice(encoded.byteOffset, encoded.byteOffset + encoded.byteLength) as ArrayBuffer;
    const fetchMock = vi
      .fn()
      .mockImplementation(() =>
        Promise.resolve(new Response(buffer, { status: 200, headers: { 'Content-Type': 'text/plain' } })),
      );
    vi.stubGlobal('fetch', fetchMock);

    const source = new KmaWeatherWarningSource();
    const result = await source.run(null);

    expect(result.events).toHaveLength(1);
    expect(result.events[0].title).toBe('서울 호우 경보 발령');
    expect(result.events[0].occurredAt).toBe('2025-01-02T00:00:00.000Z');
  });

  it('should cap occurredAt by current server time when tmFc is in the future', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2025-01-02T00:00:00.000Z'));

    process.env.KMA_API_KEY = 'test-key';
    vi.resetModules();
    const { KmaWeatherWarningSource } = await import('./kma-weather-warning.source');

    const csvText = ['11,서울,1111000000,서울특별시,202501021030,202501020600,호우,경보,발령,2025-01-02 18:00'].join(
      '\n',
    );

    const encoded = iconv.encode(csvText, 'euc-kr');
    const buffer = encoded.buffer.slice(encoded.byteOffset, encoded.byteOffset + encoded.byteLength) as ArrayBuffer;
    const fetchMock = vi
      .fn()
      .mockImplementation(() =>
        Promise.resolve(new Response(buffer, { status: 200, headers: { 'Content-Type': 'text/plain' } })),
      );
    vi.stubGlobal('fetch', fetchMock);

    const source = new KmaWeatherWarningSource();
    const result = await source.run(null);

    expect(result.events).toHaveLength(1);
    expect(result.events[0].occurredAt).toBe('2025-01-02T00:00:00.000Z');
  });

  it('should map a heat major warning to the severe level', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-07-12T02:00:00.000Z'));

    process.env.KMA_API_KEY = 'test-key';
    vi.resetModules();
    const { KmaWeatherWarningSource } = await import('./kma-weather-warning.source');

    const csvText = [
      'L1070000,경상북도,L1070500,경산시,202607121000,202607121100,폭염,중대경보,변경,',
      'L1070000,경상북도,L1072400,포항시,202607121000,202607121100,폭염,중대경보,변경,',
    ].join('\n');

    const encoded = iconv.encode(csvText, 'euc-kr');
    const buffer = encoded.buffer.slice(encoded.byteOffset, encoded.byteOffset + encoded.byteLength) as ArrayBuffer;
    const fetchMock = vi
      .fn()
      .mockImplementation(() =>
        Promise.resolve(new Response(buffer, { status: 200, headers: { 'Content-Type': 'text/plain' } })),
      );
    vi.stubGlobal('fetch', fetchMock);

    const source = new KmaWeatherWarningSource();
    const result = await source.run(null);

    expect(result.events).toHaveLength(1);
    expect(result.events[0]).toMatchObject({
      kind: EventKinds.Heat,
      level: EventLevels.Severe,
      title: '경상북도 폭염 중대경보 변경',
      regionText: '경상북도 경산시, 경상북도 포항시',
    });
  });
});
