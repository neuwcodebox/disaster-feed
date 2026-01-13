import { afterEach, describe, expect, it, vi } from 'vitest';
import { EventLevels } from '@/modules/events/domain/event.enums';
import { LandslideForecastSource } from './landslide-forecast.source';

describe('LandslideForecastSource', () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('should parse forecast table and emit issued alerts only', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2025-10-25T06:30:00.000Z'));

    const html = `
      <table id="fctTbl">
        <tbody>
          <tr>
            <td>
              <a href="javascript:fn_moveAlertView('47940', '', '12310');">경상북도 울릉군</a>
            </td>
            <td>
              <a href="javascript:fn_moveAlertView('47940','','12310');" title="주의보">주의보</a>
            </td>
            <td>
              <a href="javascript:fn_moveAlertView('47940','','12310');" title="2025-10-25 13:19">2025-10-25<br>13:19</a>
            </td>
            <td>
              <a href="javascript:fn_moveAlertView('47940','','12310');" title="2025-10-25 14:10">2025-10-25<br>14:10</a>
            </td>
            <td>
              <a href="javascript:fn_moveAlertView('47940','','12310');" title="-">-</a>
            </td>
            <td>
              <a href="javascript:fn_moveAlertView('47940','','12310');" title="작성자">작성자</a>
            </td>
            <td>발령</td>
          </tr>
          <tr>
            <td>
              <a href="javascript:fn_moveAlertView('11110', '', '99999');">서울특별시 종로구</a>
            </td>
            <td>
              <a href="javascript:fn_moveAlertView('11110','','99999');" title="경보">경보</a>
            </td>
            <td>
              <a href="javascript:fn_moveAlertView('11110','','99999');" title="2025-10-25 11:00">2025-10-25<br>11:00</a>
            </td>
            <td>
              <a href="javascript:fn_moveAlertView('11110','','99999');" title="2025-10-25 11:10">2025-10-25<br>11:10</a>
            </td>
            <td>
              <a href="javascript:fn_moveAlertView('11110','','99999');" title="2025-10-25 12:00">2025-10-25<br>12:00</a>
            </td>
            <td>
              <a href="javascript:fn_moveAlertView('11110','','99999');" title="작성자">작성자</a>
            </td>
            <td>해제</td>
          </tr>
        </tbody>
      </table>
    `;

    const fetchMock = vi.fn().mockImplementation(() => Promise.resolve(new Response(html, { status: 200 })));
    vi.stubGlobal('fetch', fetchMock);

    const source = new LandslideForecastSource();
    const result = await source.run(null);

    expect(result.events).toHaveLength(1);
    expect(result.events[0].title).toBe('경상북도 울릉군 산사태 주의보 발령');
    expect(result.events[0].level).toBe(EventLevels.Minor);
    expect(result.events[0].regionCodes).toEqual(['4794000000']);
    expect(result.events[0].occurredAt).toBe('2025-10-25T04:19:00.000Z');
  });
});
