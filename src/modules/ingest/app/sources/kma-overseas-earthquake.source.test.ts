import { afterEach, describe, expect, it, vi } from 'vitest';

describe('KmaOverseasEarthquakeSource', () => {
  afterEach(() => {
    delete process.env.KMA_API_KEY;
    vi.useRealTimers();
    vi.unstubAllGlobals();
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
