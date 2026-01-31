import { afterEach, describe, expect, it, vi } from 'vitest';
import { EventKinds, EventLevels } from '@/modules/events/domain/event.enums';
import type { StationInfo } from '../../domain/port/station-repo.interface';

describe('KmaAwsObservationSource', () => {
  afterEach(() => {
    delete process.env.KMA_API_KEY;
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('should emit wind events and avoid duplicates', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-31T03:00:00.000Z'));

    process.env.KMA_API_KEY = 'test-key';

    const csvText = buildAwsCsvRow({
      ws1: 20.0,
      wss: 45.0,
      ws10: 20.0,
      ta: 5.0,
    });
    const { source } = await createSource(csvText);

    const result1 = await source.run(null);
    expect(result1.events).toHaveLength(2);
    expect(result1.events[0].level).toBe(EventLevels.Severe);
    expect(result1.events[0].title).toBe('테스트관측소 순간 풍속 45.0 m/s 관측');
    expect(result1.events[1].level).toBe(EventLevels.Minor);
    expect(result1.events[1].title).toBe('테스트관측소 10분 평균 풍속 20.0 m/s 관측');

    const result2 = await source.run(result1.nextState);
    expect(result2.events).toHaveLength(0);
  });

  it('should emit rain intensity and accumulation events', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-31T03:00:00.000Z'));

    process.env.KMA_API_KEY = 'test-key';

    const csvText = buildAwsCsvRow({
      rn60m: 50.0,
      rn12h: 200.0,
      ta: 8.0,
    });
    const { source } = await createSource(csvText);

    const result = await source.run(null);
    expect(result.events).toHaveLength(2);

    const intensityEvent = result.events.find((event) => event.title.includes('시간당')) ?? null;
    expect(intensityEvent).not.toBeNull();
    expect(intensityEvent?.kind).toBe(EventKinds.Rain);
    expect(intensityEvent?.title).toBe('테스트관측소 시간당 강수 50 mm 관측');

    const accumEvent = result.events.find((event) => event.title.includes('12시간')) ?? null;
    expect(accumEvent).not.toBeNull();
    expect(accumEvent?.kind).toBe(EventKinds.Rain);
    expect(accumEvent?.title).toBe('테스트관측소 12시간 강수 200 mm 관측');
  });

  it('should format hourly rain from 60-minute accumulation', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-31T03:00:00.000Z'));

    process.env.KMA_API_KEY = 'test-key';

    const csvText = buildAwsCsvRow({
      rn60m: 100.0,
      rn12h: 0.0,
      ws1: 2.0,
      wss: 3.0,
      ta: 10.0,
    });
    const { source } = await createSource(csvText);

    const result = await source.run(null);
    expect(result.events).toHaveLength(1);
    expect(result.events[0].title).toBe('테스트관측소 시간당 강수 100 mm 관측');
  });

  it('should emit temperature events with plain wording', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-31T03:00:00.000Z'));

    process.env.KMA_API_KEY = 'test-key';

    const csvText = buildAwsCsvRow({
      ta: 37.0,
      ws1: 5.0,
      wss: 8.0,
    });
    const { source } = await createSource(csvText);

    const result = await source.run(null);
    expect(result.events).toHaveLength(1);
    expect(result.events[0].kind).toBe(EventKinds.Heat);
    expect(result.events[0].title).toBe('테스트관측소 기온 37.0 ℃ 관측');
    expect(result.events[0].title).not.toContain('폭염');
    expect(result.events[0].title).not.toContain('한파');
  });

  it('should skip events when station info is missing', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-31T03:00:00.000Z'));

    process.env.KMA_API_KEY = 'test-key';

    const csvText = buildAwsCsvRow({
      ws1: 20.0,
      wss: 45.0,
      rn12h: 200.0,
      ta: 37.0,
    });
    const { source } = await createSource(csvText, null);

    const result = await source.run(null);
    expect(result.events).toHaveLength(0);
  });
});

type AwsCsvOverrides = {
  timestamp?: string;
  station?: number;
  ws1?: number;
  wss?: number;
  ws10?: number;
  ta?: number;
  rn60m?: number;
  rn12h?: number;
};

function buildAwsCsvRow(overrides: AwsCsvOverrides): string {
  const row = {
    timestamp: '202601311155',
    station: 90,
    wd1: 0.0,
    ws1: 0.0,
    wds: 0.0,
    wss: 0.0,
    wd10: 0.0,
    ws10: 0.0,
    ta: 0.0,
    re: 0.0,
    rn15m: 0.0,
    rn60m: 0.0,
    rn12h: 0.0,
    rnDay: 0.0,
    hm: 30.0,
    pa: 1000.0,
    ps: 1005.0,
    td: 0.0,
  };

  const values = { ...row, ...overrides };

  return [
    values.timestamp,
    values.station,
    values.wd1,
    values.ws1,
    values.wds,
    values.wss,
    values.wd10,
    values.ws10,
    values.ta,
    values.re,
    values.rn15m,
    values.rn60m,
    values.rn12h,
    values.rnDay,
    values.hm,
    values.pa,
    values.ps,
    values.td,
    '=',
  ].join(',');
}

async function createSource(csvText: string, stationInfo?: StationInfo | null) {
  const fetchMock = vi.fn().mockImplementation(() => Promise.resolve(new Response(csvText, { status: 200 })));
  vi.stubGlobal('fetch', fetchMock);

  const defaultStation: StationInfo = {
    code: 90,
    startDate: '20000101',
    endDate: null,
    name: '테스트관측소',
    address: '서울특별시',
    office: null,
    lat: 37.5,
    lng: 127.0,
    altitudeM: null,
    barometerM: null,
    thermometerM: null,
    anemometerM: null,
    rainGaugeM: null,
  };

  const stationRepo = {
    findByCode: vi.fn().mockResolvedValue(stationInfo === undefined ? defaultStation : stationInfo),
  };

  const { KmaAwsObservationSource } = await import('./kma-aws-observation.source');
  return { source: new KmaAwsObservationSource(stationRepo) };
}
