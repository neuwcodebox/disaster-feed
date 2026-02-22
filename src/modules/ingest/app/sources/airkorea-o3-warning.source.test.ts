import { afterEach, describe, expect, it, vi } from 'vitest';
import { EventLevels } from '@/modules/events/domain/event.enums';
import { AirkoreaO3WarningSource } from './airkorea-o3-warning.source';

describe('AirkoreaO3WarningSource', () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('should group ozone warning rows and build events', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2025-01-02T02:00:00.000Z'));

    const html = `
      <table>
        <tbody>
          <tr>
            <td>1</td>
            <td>서울</td>
            <td>강남권역</td>
            <td>주의보</td>
            <td>2025-01-02 09</td>
            <td></td>
          </tr>
          <tr>
            <td>2</td>
            <td>서울</td>
            <td>서초권역</td>
            <td>주의보</td>
            <td>2025-01-02 09</td>
            <td></td>
          </tr>
        </tbody>
      </table>
    `;

    const fetchMock = vi.fn().mockImplementation(() => Promise.resolve(new Response(html, { status: 200 })));
    vi.stubGlobal('fetch', fetchMock);

    const source = new AirkoreaO3WarningSource();
    const result = await source.run(null);

    expect(result.events).toHaveLength(1);
    expect(result.events[0].title).toBe('서울 강남, 서초 권역 오존 주의보');
    expect(result.events[0].body).toBeUndefined();
    expect(result.events[0].occurredAt).toBe('2025-01-02T00:00:00.000Z');
    expect(result.events[0].level).toBe(EventLevels.Minor);
  });

  it('should remove duplicated region zone in title', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2025-01-02T02:00:00.000Z'));

    const html = `
      <table>
        <tbody>
          <tr>
            <td>1</td>
            <td>서울</td>
            <td>서울권역</td>
            <td>경보</td>
            <td>2025-01-02 09</td>
            <td></td>
          </tr>
        </tbody>
      </table>
    `;

    const fetchMock = vi.fn().mockImplementation(() => Promise.resolve(new Response(html, { status: 200 })));
    vi.stubGlobal('fetch', fetchMock);

    const source = new AirkoreaO3WarningSource();
    const result = await source.run(null);

    expect(result.events).toHaveLength(1);
    expect(result.events[0].title).toBe('서울 권역 오존 경보');
    expect(result.events[0].body).toBeUndefined();
  });

  it('should cap future issued time to now', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2025-01-02T02:00:00.000Z'));

    const html = `
      <table>
        <tbody>
          <tr>
            <td>1</td>
            <td>서울</td>
            <td>강남구</td>
            <td>주의보</td>
            <td>2025-01-03 09</td>
            <td></td>
          </tr>
        </tbody>
      </table>
    `;

    const fetchMock = vi.fn().mockImplementation(() => Promise.resolve(new Response(html, { status: 200 })));
    vi.stubGlobal('fetch', fetchMock);

    const source = new AirkoreaO3WarningSource();
    const result = await source.run(null);

    expect(result.events).toHaveLength(1);
    expect(result.events[0].occurredAt).toBe('2025-01-02T02:00:00.000Z');
  });
});
