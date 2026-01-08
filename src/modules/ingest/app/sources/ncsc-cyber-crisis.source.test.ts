import { afterEach, describe, expect, it, vi } from 'vitest';
import { EventLevels } from '@/modules/events/domain/event.enums';
import { NcscCyberCrisisSource } from './ncsc-cyber-crisis.source';

describe('NcscCyberCrisisSource', () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('should parse crisis table and emit events', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2025-01-02T01:23:45.000Z'));

    const html = `
      <div id="cnt0">
        <form>
          <table>
            <tr>
              <td>1</td>
              <td>사이버 위기 단계 상향</td>
              <td>심각</td>
              <td>2025-01-02</td>
            </tr>
          </table>
        </form>
      </div>
    `;

    const fetchMock = vi.fn().mockImplementation(() => Promise.resolve(new Response(html, { status: 200 })));
    vi.stubGlobal('fetch', fetchMock);

    const source = new NcscCyberCrisisSource();
    const result = await source.run(null);

    expect(result.events).toHaveLength(1);
    expect(result.events[0].title).toBe('사이버 위기 단계 상향');
    expect(result.events[0].level).toBe(EventLevels.Severe);
    expect(result.events[0].occurredAt).toBe('2025-01-02T01:23:45.000Z');
  });
});
