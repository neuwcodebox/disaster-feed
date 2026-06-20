import { afterEach, describe, expect, it, vi } from 'vitest';
import { EventLevels } from '@/modules/events/domain/event.enums';
import { NcscCyberCrisisSource } from './ncsc-cyber-crisis.source';

describe('NcscCyberCrisisSource', () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('should fetch current crisis board and emit events', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2025-01-02T01:23:45.000Z'));

    const payload = {
      header: { msgCode: '1000', msg: '정상처리', dataCnt: 2, effectCnt: 0 },
      data: [
        {
          cnt: 1,
          str: null,
          list: [
            {
              bbscttId: 'BBSCTT00000001',
              bbsId: 'BBS000313',
              sj: '사이버 위기 단계 상향',
              scrtyLevel: '심각',
              gnfdDe: '2025-01-02 10:23:45',
              registDttm: '2025-01-02 00:00:00',
              cnHtml: '<p>대응 요령</p><p>보안관제 강화</p>',
              rowIdx: '1',
              updtDttm: '2025-01-02 11:00:00',
            },
          ],
        },
        {
          cnt: 1,
          str: null,
          list: [{ totalCnt: 1, pageIndex: 1, totalPage: 1, pageSize: 10 }],
        },
      ],
    };

    const fetchMock = vi.fn().mockImplementation(() => Promise.resolve(Response.json(payload)));
    vi.stubGlobal('fetch', fetchMock);

    const source = new NcscCyberCrisisSource();
    const result = await source.run(null);

    expect(fetchMock).toHaveBeenCalledOnce();
    expect(fetchMock).toHaveBeenCalledWith(
      'https://www.ncsc.go.kr/api/usr/bbs/selectBbscttList',
      expect.objectContaining({
        body: JSON.stringify({ bbsId: 'BBS000313', pageIndex: 1, pageSize: 10 }),
      }),
    );
    expect(result.events).toHaveLength(1);
    expect(result.events[0].title).toBe('사이버 위기 단계 상향');
    expect(result.events[0].body).toBe('대응 요령 보안관제 강화');
    expect(result.events[0].level).toBe(EventLevels.Severe);
    expect(result.events[0].occurredAt).toBe('2025-01-02T01:23:45.000Z');
    expect(result.events[0].payload).toMatchObject({
      bbscttId: 'BBSCTT00000001',
      bbsId: 'BBS000313',
      level: '심각',
      issuedAt: '2025-01-02 10:23:45',
      issuedAtIso: '2025-01-02T01:23:45.000Z',
    });
  });
});
