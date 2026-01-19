import { afterEach, describe, expect, it, vi } from 'vitest';
import { EventKinds, EventLevels } from '@/modules/events/domain/event.enums';

vi.mock('undici', async () => {
  const actual = await vi.importActual<typeof import('undici')>('undici');
  return {
    ...actual,
    fetch: vi.fn(),
  };
});

describe('UticTrafficIncidentSource', () => {
  afterEach(() => {
    delete process.env.UTIC_API_KEY;
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('should parse incidents and emit events', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-19T10:00:00.000Z'));

    process.env.UTIC_API_KEY = 'test-key';
    vi.resetModules();

    const xml = `<?xml version="1.0" encoding="UTF-8"?>
      <result>
        <record>
          <incidentId>INC1</incidentId>
          <incidenteTypeCd>1</incidenteTypeCd>
          <incidenteGradeCd>A0401</incidenteGradeCd>
          <addressJibunCd>4122037030</addressJibunCd>
          <locationDataX>126.92354015</locationDataX>
          <locationDataY>36.933405701001426</locationDataY>
          <incidentTitle>[사고] 테스트 사고 - 1차로 통제</incidentTitle>
          <startDate>2026년 01월 19일 18시 25분</startDate>
        </record>
        <record>
          <incidentId>INC2</incidentId>
          <incidenteTypeCd>5</incidenteTypeCd>
          <incidenteGradeCd>A0402</incidenteGradeCd>
          <addressJibun>서울특별시 중구 세종대로 110</addressJibun>
          <incidentTitle>[통제] 테스트 통제</incidentTitle>
          <startDate>2026년 01월 19일 18시 20분</startDate>
        </record>
        <record>
          <incidentId>INC3</incidentId>
          <incidenteTypeCd>2</incidenteTypeCd>
          <incidentTitle>[공사] 제외 대상</incidentTitle>
          <startDate>2026년 01월 19일 18시 15분</startDate>
        </record>
      </result>
    `;

    const { Response, fetch } = await import('undici');
    const fetchMock = fetch as unknown as ReturnType<typeof vi.fn>;
    fetchMock.mockImplementation(() =>
      Promise.resolve(
        new Response(Buffer.from(xml, 'utf-8'), {
          status: 200,
          headers: { 'content-type': 'application/xml; charset=utf-8' },
        }),
      ),
    );

    const { UticTrafficIncidentSource } = await import('./utic-traffic-incident.source');
    const source = new UticTrafficIncidentSource();
    const result = await source.run(null);

    expect(result.events).toHaveLength(2);
    expect(result.events[0].kind).toBe(EventKinds.Transport);
    expect(result.events[0].level).toBe(EventLevels.Minor);
    expect(result.events[0].title).toBe('[사고] 테스트 사고');
    expect(result.events[0].body).toBe('1차로 통제');
    expect(result.events[0].geo).toEqual({ lat: 36.933405701001426, lng: 126.92354015 });
    expect(result.events[0].regionCodes).toEqual(['4122037030']);
    expect(result.events[1].title).toBe('[통제] 테스트 통제');
  });
});
