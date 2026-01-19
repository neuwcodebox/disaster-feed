import { afterEach, describe, expect, it, vi } from 'vitest';
import { EventKinds, EventLevels } from '@/modules/events/domain/event.enums';

vi.mock('undici', async () => {
  const actual = await vi.importActual<typeof import('undici')>('undici');
  return {
    ...actual,
    fetch: vi.fn(),
  };
});

describe('KasaSpaceWeatherWarningSource', () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('should store initial levels without emitting events', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2025-01-01T00:00:00.000Z'));

    const payload = buildResponsePayload({
      R: 'R1',
      S: 'S0',
      G: 'G0',
    });
    const { Response, fetch } = await import('undici');
    const fetchMock = fetch as unknown as ReturnType<typeof vi.fn>;
    fetchMock.mockImplementation(() => Promise.resolve(new Response(JSON.stringify(payload), { status: 200 })));

    const { KasaSpaceWeatherWarningSource } = await import('./kasa-space-weather-warning.source');
    const source = new KasaSpaceWeatherWarningSource();
    const result = await source.run(null);

    expect(result.events).toHaveLength(0);
    const nextState = JSON.parse(result.nextState ?? '{}') as { warns?: Record<string, { level: number }> };
    expect(nextState.warns?.R?.level).toBe(1);
    expect(nextState.warns?.S?.level).toBe(0);
    expect(nextState.warns?.G?.level).toBe(0);
  });

  it('should emit event when level increases', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2025-01-01T01:00:00.000Z'));

    const payload = buildResponsePayload({
      R: 'R3',
      S: 'S0',
      G: 'G0',
    });
    const { Response, fetch } = await import('undici');
    const fetchMock = fetch as unknown as ReturnType<typeof vi.fn>;
    fetchMock.mockImplementation(() => Promise.resolve(new Response(JSON.stringify(payload), { status: 200 })));

    const previousState = JSON.stringify({
      warns: {
        R: { level: 1, confirmedAt: '2025-01-01T00:50:00.000Z' },
        S: { level: 0, confirmedAt: '2025-01-01T00:50:00.000Z' },
        G: { level: 0, confirmedAt: '2025-01-01T00:50:00.000Z' },
      },
    });

    const { KasaSpaceWeatherWarningSource } = await import('./kasa-space-weather-warning.source');
    const source = new KasaSpaceWeatherWarningSource();
    const result = await source.run(previousState);

    expect(result.events).toHaveLength(1);
    expect(result.events[0].title).toBe('태양흑점폭발 3단계 경보 상황 발생');
    expect(result.events[0].level).toBe(EventLevels.Minor);
    expect(result.events[0].kind).toBe(EventKinds.SpaceWeather);
    expect(result.events[0].payload?.direction).toBe('up');
  });

  it('should delay downgrade events within the grace period', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2025-01-01T01:30:00.000Z'));

    const payload = buildResponsePayload({
      R: 'R1',
      S: 'S0',
      G: 'G0',
    });
    const { Response, fetch } = await import('undici');
    const fetchMock = fetch as unknown as ReturnType<typeof vi.fn>;
    fetchMock.mockImplementation(() => Promise.resolve(new Response(JSON.stringify(payload), { status: 200 })));

    const previousState = JSON.stringify({
      warns: {
        R: { level: 3, confirmedAt: '2025-01-01T01:00:30.000Z' },
        S: { level: 0, confirmedAt: '2025-01-01T01:00:30.000Z' },
        G: { level: 0, confirmedAt: '2025-01-01T01:00:30.000Z' },
      },
    });

    const { KasaSpaceWeatherWarningSource } = await import('./kasa-space-weather-warning.source');
    const source = new KasaSpaceWeatherWarningSource();
    const result = await source.run(previousState);

    expect(result.events).toHaveLength(0);
    const nextState = JSON.parse(result.nextState ?? '{}') as {
      warns?: Record<string, { level: number; confirmedAt: string }>;
    };
    expect(nextState.warns?.R?.level).toBe(3);
  });

  it('should emit downgrade event after the grace period', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2025-01-01T02:10:00.000Z'));

    const payload = buildResponsePayload({
      R: 'R1',
      S: 'S0',
      G: 'G0',
    });
    const { Response, fetch } = await import('undici');
    const fetchMock = fetch as unknown as ReturnType<typeof vi.fn>;
    fetchMock.mockImplementation(() => Promise.resolve(new Response(JSON.stringify(payload), { status: 200 })));

    const previousState = JSON.stringify({
      warns: {
        R: { level: 3, confirmedAt: '2025-01-01T01:00:00.000Z' },
        S: { level: 0, confirmedAt: '2025-01-01T01:00:00.000Z' },
        G: { level: 0, confirmedAt: '2025-01-01T01:00:00.000Z' },
      },
    });

    const { KasaSpaceWeatherWarningSource } = await import('./kasa-space-weather-warning.source');
    const source = new KasaSpaceWeatherWarningSource();
    const result = await source.run(previousState);

    expect(result.events).toHaveLength(1);
    expect(result.events[0].title).toBe('태양흑점폭발 3단계 경보 상황 종료 (현재 1단계)');
    expect(result.events[0].level).toBe(EventLevels.Info);
    expect(result.events[0].payload?.direction).toBe('down');
  });
});

type WarnLevels = {
  R: string;
  S: string;
  G: string;
};

function buildResponsePayload(levels: WarnLevels) {
  return {
    Warn: {
      R: { v0: levels.R, v1: levels.R, v2: levels.R },
      S: { v0: levels.S, v1: levels.S, v2: levels.S },
      G: { v0: levels.G, v1: levels.G, v2: levels.G },
    },
    LastUpdate: '1768821900000',
    Error: false,
    ErrorCode: 'NOERR',
  };
}
