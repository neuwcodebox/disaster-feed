import { afterEach, describe, expect, it, vi } from 'vitest';
import { EventLevels } from '@/modules/events/domain/event.enums';
import { AirkoreaPmWarningSource } from './airkorea-pm-warning.source';

describe('AirkoreaPmWarningSource', () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('should group warning rows and build event', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2025-01-02T02:00:00.000Z'));

    const htmlWithRows = `
      <div id="dataSearch">
        <div>
          <div class="contSub">
            <div class="tblList">
              <table>
                <tbody>
                  <tr>
                    <td>1</td>
                    <td>서울</td>
                    <td>종로구</td>
                    <td>미세먼지</td>
                    <td>주의보</td>
                    <td>2025-01-02 09</td>
                    <td></td>
                  </tr>
                  <tr>
                    <td>2</td>
                    <td>서울</td>
                    <td>강남구</td>
                    <td>미세먼지</td>
                    <td>주의보</td>
                    <td>2025-01-02 09</td>
                    <td></td>
                  </tr>
                </tbody>
              </table>
            </div>
          </div>
        </div>
      </div>
    `;
    const htmlEmpty = `
      <div id="dataSearch">
        <div>
          <div class="contSub">
            <div class="tblList">
              <table>
                <tbody>
                  <tr>
                    <td>자료가 없습니다</td>
                  </tr>
                </tbody>
              </table>
            </div>
          </div>
        </div>
      </div>
    `;

    const fetchMock = vi
      .fn()
      .mockImplementationOnce(() => Promise.resolve(new Response(htmlWithRows, { status: 200 })))
      .mockImplementationOnce(() => Promise.resolve(new Response(htmlEmpty, { status: 200 })));
    vi.stubGlobal('fetch', fetchMock);

    const source = new AirkoreaPmWarningSource();
    const result = await source.run(null);

    expect(result.events).toHaveLength(1);
    expect(result.events[0].title).toBe('서울 미세먼지 주의보');
    expect(result.events[0].body).toBe('권역: 종로구, 강남구');
    expect(result.events[0].occurredAt).toBe('2025-01-02T00:00:00.000Z');
    expect(result.events[0].level).toBe(EventLevels.Minor);
    expect(result.nextState).not.toBeNull();
  });

  it('should cap future issued time to now', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2025-01-02T02:00:00.000Z'));

    const htmlWithRows = `
      <div id="dataSearch">
        <div>
          <div class="contSub">
            <div class="tblList">
              <table>
                <tbody>
                  <tr>
                    <td>1</td>
                    <td>서울</td>
                    <td>강남구</td>
                    <td>미세먼지</td>
                    <td>주의보</td>
                    <td>2025-01-03 09</td>
                    <td></td>
                  </tr>
                </tbody>
              </table>
            </div>
          </div>
        </div>
      </div>
    `;
    const htmlEmpty = `
      <div id="dataSearch">
        <div>
          <div class="contSub">
            <div class="tblList">
              <table>
                <tbody>
                  <tr>
                    <td>자료가 없습니다</td>
                  </tr>
                </tbody>
              </table>
            </div>
          </div>
        </div>
      </div>
    `;

    const fetchMock = vi
      .fn()
      .mockImplementationOnce(() => Promise.resolve(new Response(htmlWithRows, { status: 200 })))
      .mockImplementationOnce(() => Promise.resolve(new Response(htmlEmpty, { status: 200 })));
    vi.stubGlobal('fetch', fetchMock);

    const source = new AirkoreaPmWarningSource();
    const result = await source.run(null);

    expect(result.events).toHaveLength(1);
    expect(result.events[0].occurredAt).toBe('2025-01-02T02:00:00.000Z');
  });
});
