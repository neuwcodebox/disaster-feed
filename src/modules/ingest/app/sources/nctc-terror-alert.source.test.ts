import { afterEach, describe, expect, it, vi } from 'vitest';
import { EventLevels } from '@/modules/events/domain/event.enums';
import { NctcTerrorAlertSource } from './nctc-terror-alert.source';

describe('NctcTerrorAlertSource', () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('should parse list and detail pages to build events', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2025-01-02T00:00:00.000Z'));

    const listHtml = `
      <div id="real-content">
        <table>
          <tr>
            <td>10</td>
            <td><a href="?mode=view&articleNo=10">테러경보 발령</a></td>
            <td>경계</td>
            <td>2025-01-02</td>
            <td></td>
            <td>전국</td>
          </tr>
        </table>
      </div>
    `;

    const detailHtml = `
      <div id="real-content">
        <dl class="board-write-box board-write-box-v03">
          <dd><div>상세 내용입니다.</div></dd>
          <dd class="view-tit">테러경보 상세 제목</dd>
        </dl>
      </div>
    `;

    const fetchMock = vi
      .fn()
      .mockImplementationOnce(() => Promise.resolve(new Response(listHtml, { status: 200 })))
      .mockImplementationOnce(() => Promise.resolve(new Response(detailHtml, { status: 200 })));
    vi.stubGlobal('fetch', fetchMock);

    const source = new NctcTerrorAlertSource();
    const result = await source.run(null);

    expect(result.events).toHaveLength(1);
    expect(result.events[0].title).toBe('테러경보 상세 제목');
    expect(result.events[0].body).toContain('상세 내용');
    expect(result.events[0].level).toBe(EventLevels.Moderate);
    expect(result.events[0].occurredAt).toBe('2025-01-02T00:00:00.000Z');
  });
});
