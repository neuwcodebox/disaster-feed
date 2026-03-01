import { afterEach, describe, expect, it, vi } from 'vitest';
import { EventKinds, EventLevels } from '@/modules/events/domain/event.enums';

const sampleOverseasEarthquakeXml = `<?xml version="1.0" encoding="UTF-8"?>
<alert>
  <earthqueakNoti>
    <info>
      <msgCode>국외지진정보</msgCode>
      <cntDiv>N</cntDiv>
      <arDiv>S</arDiv>
      <eqArCdNm>기타해역</eqArCdNm>
      <eqPt>일본 가고시마현 가고시마시 남쪽 56km 해역</eqPt>
      <nkDiv>N</nkDiv>
      <tmIssue>20260301180745</tmIssue>
      <eqDate>20260301180000</eqDate>
      <magMl>5.4</magMl>
      <magDiff>-</magDiff>
      <eqDt>130</eqDt>
      <eqLt>31.10</eqLt>
      <eqLn>130.60</eqLn>
      <majorAxis>-</majorAxis>
      <minorAxis>-</minorAxis>
      <depthDiff>-</depthDiff>
      <jdLoc>Ⅱ</jdLoc>
      <jdLocA>Ⅱ(경남,전남,제주)</jdLocA>
      <ReFer>국내 일부지역에서 지진동을 느낄수 있음. 안전에 유의하기 바람.</ReFer>
    </info>
  </earthqueakNoti>
</alert>`;

function stubXmlFetch(xml: string): void {
  const fetchMock = vi.fn().mockImplementation(() => Promise.resolve(new Response(xml, { status: 200 })));
  vi.stubGlobal('fetch', fetchMock);
}

function buildXmlWithInfo(infoBlocks: string): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<alert>
  <earthqueakNoti>
${infoBlocks}
  </earthqueakNoti>
</alert>`;
}

describe('KmaOverseasEarthquakeSource', () => {
  afterEach(() => {
    delete process.env.KMA_API_KEY;
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('should not emit events on initial run even when domestic impact exists', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-03-01T09:10:00.000Z'));

    process.env.KMA_API_KEY = 'test-key';
    vi.resetModules();
    const { KmaOverseasEarthquakeSource } = await import('./kma-overseas-earthquake.source');
    stubXmlFetch(sampleOverseasEarthquakeXml);

    const source = new KmaOverseasEarthquakeSource();
    const result = await source.run(null);

    expect(result.events).toHaveLength(0);
    expect(result.nextState).not.toBeNull();

    const parsedState = JSON.parse(result.nextState ?? '{}') as { seen?: Record<string, string> };
    expect(Object.keys(parsedState.seen ?? {})).toContain('20260301180000:20260301180745');
  });

  it('should emit event when checkpoint exists but event id is unseen', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-03-01T09:10:00.000Z'));

    process.env.KMA_API_KEY = 'test-key';
    vi.resetModules();
    const { KmaOverseasEarthquakeSource } = await import('./kma-overseas-earthquake.source');
    stubXmlFetch(sampleOverseasEarthquakeXml);

    const source = new KmaOverseasEarthquakeSource();
    const previousState = JSON.stringify({
      seen: {
        '20260301170000:20260301170500': '2026-03-01T09:00:00.000Z',
      },
    });

    const result = await source.run(previousState);

    expect(result.events).toHaveLength(1);
    expect(result.events[0]).toMatchObject({
      kind: EventKinds.Quake,
      level: EventLevels.Info,
      title: '일본 가고시마현 가고시마시 남쪽 56km 해역 규모 5.4 지진',
      occurredAt: '2026-03-01T09:00:00.000Z',
      regionText: '일본 가고시마현 가고시마시 남쪽 56km 해역',
    });
    expect(result.events[0].body).toContain('국내 최대진도: Ⅱ');
    expect(result.events[0].body).toContain('지역별 진도: Ⅱ(경남,전남,제주)');
    expect(result.events[0].body).toContain('깊이: 130.0 km');
    expect(result.events[0].body).toContain('발표 시각: 2026-03-01 18:07:45 KST');
  });

  it('should keep empty checkpoint as non-null and emit on next run', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-03-01T09:10:00.000Z'));

    process.env.KMA_API_KEY = 'test-key';
    vi.resetModules();
    const { KmaOverseasEarthquakeSource } = await import('./kma-overseas-earthquake.source');

    const noImpactXml = buildXmlWithInfo(`    <info>
      <msgCode>국외지진정보</msgCode>
      <cntDiv>N</cntDiv>
      <eqPt>국외 먼바다</eqPt>
      <tmIssue>20260301170000</tmIssue>
      <eqDate>20260301165000</eqDate>
      <magMl>4.1</magMl>
      <jdLoc>-</jdLoc>
      <jdLocA>-</jdLocA>
    </info>`);

    const responses = [noImpactXml, sampleOverseasEarthquakeXml];
    const fetchMock = vi.fn().mockImplementation(() => {
      const xml = responses.shift() ?? noImpactXml;
      return Promise.resolve(new Response(xml, { status: 200 }));
    });
    vi.stubGlobal('fetch', fetchMock);

    const source = new KmaOverseasEarthquakeSource();
    const firstResult = await source.run(null);
    expect(firstResult.nextState).toBe(JSON.stringify({ seen: {} }));

    const secondResult = await source.run(firstResult.nextState);
    expect(secondResult.events).toHaveLength(1);
    expect(secondResult.events[0]).toMatchObject({
      kind: EventKinds.Quake,
      title: '일본 가고시마현 가고시마시 남쪽 56km 해역 규모 5.4 지진',
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('should emit overseas earthquake events with domestic impact only', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-22T01:00:00.000Z'));

    process.env.KMA_API_KEY = 'test-key';
    vi.resetModules();
    const { KmaOverseasEarthquakeSource } = await import('./kma-overseas-earthquake.source');

    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<alert>
  <earthqueakNoti>
    <info>
      <msgCode>국외지진정보</msgCode>
      <cntDiv>N</cntDiv>
      <arDiv>S</arDiv>
      <eqArCdNm>기타해역</eqArCdNm>
      <eqPt>일본 나가사키현 대마도 남쪽 56km 해역</eqPt>
      <nkDiv>N</nkDiv>
      <tmIssue>20260122155935</tmIssue>
      <eqDate>20260122154900</eqDate>
      <magMl>3.5</magMl>
      <magDiff>-</magDiff>
      <eqDt>10</eqDt>
      <eqLt>33.70</eqLt>
      <eqLn>129.30</eqLn>
      <majorAxis>-</majorAxis>
      <minorAxis>-</minorAxis>
      <depthDiff>-</depthDiff>
      <jdLoc>Ⅱ</jdLoc>
      <jdLocA>Ⅱ(경남)</jdLocA>
      <ReFer>국내 일부지역에서 지진동을 느낄수 있음.</ReFer>
    </info>
    <info>
      <msgCode>국외지진정보</msgCode>
      <cntDiv>N</cntDiv>
      <arDiv>S</arDiv>
      <eqArCdNm>기타해역</eqArCdNm>
      <eqPt>일본 시즈오카현 하마마쓰시 남남동쪽 1375km 해역</eqPt>
      <nkDiv>N</nkDiv>
      <tmIssue>20260122020104</tmIssue>
      <eqDate>20260122013745</eqDate>
      <magMl>6.1</magMl>
      <magDiff>-</magDiff>
      <eqDt>26</eqDt>
      <eqLt>23.11</eqLt>
      <eqLn>142.64</eqLn>
      <majorAxis>-</majorAxis>
      <minorAxis>-</minorAxis>
      <depthDiff>-</depthDiff>
      <jdLoc>-</jdLoc>
      <jdLocA>-</jdLocA>
      <ReFer>국내영향없음.</ReFer>
    </info>
  </earthqueakNoti>
</alert>`;

    const fetchMock = vi.fn().mockImplementation(() => Promise.resolve(new Response(xml, { status: 200 })));
    vi.stubGlobal('fetch', fetchMock);

    const source = new KmaOverseasEarthquakeSource();
    const firstResult = await source.run(null);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const requestUrl = String(fetchMock.mock.calls[0]?.[0]);
    expect(requestUrl).toContain('frDate=20260121');
    expect(requestUrl).toContain('laDate=20260122');
    expect(requestUrl).toContain('authKey=test-key');

    expect(firstResult.events).toHaveLength(0);
    expect(firstResult.nextState).not.toBeNull();

    const parsedState = JSON.parse(firstResult.nextState ?? '{}') as { seen?: Record<string, string> };
    expect(Object.keys(parsedState.seen ?? {})).toContain('20260122154900:20260122155935');

    const secondResult = await source.run(firstResult.nextState);
    expect(secondResult.events).toHaveLength(0);
    expect(secondResult.nextState).not.toBeNull();
  });
});
