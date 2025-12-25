import { afterEach, describe, expect, it, vi } from 'vitest';
import { KmaMicroEarthquakeSource } from './kma-micro-earthquake.source';

describe('KmaMicroEarthquakeSource', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('should parse magnitude and depth and build concise title', async () => {
    const html =
      '<p class="p_hypen"><span style="color:#0000ff; font-weight:bold;">[최근 미소지진 발생 현황(규모 2.0미만)]</span><br/> 2025/12/25 05:14:43 경남 밀양시 동쪽 15km 지역 &#40;규모:1.5 / 깊이:8km&#41;</p>';

    const fetchMock = vi.fn().mockImplementation(() => Promise.resolve(new Response(html, { status: 200 })));
    vi.stubGlobal('fetch', fetchMock);

    const source = new KmaMicroEarthquakeSource();
    const result = await source.run(null);

    expect(result.events).toHaveLength(1);
    expect(result.events[0].title).toBe('경남 밀양시 동쪽 15km 지역 규모 1.5 미소지진');
    expect(result.events[0].occurredAt).toBe('2025-12-24T20:14:43.000Z');
    expect(result.events[0].regionText).toBe('경남 밀양시 동쪽 15km 지역');
    expect(result.events[0].payload?.depthKm).toBe(8);
    expect(result.nextState).toBe(
      '[최근 미소지진 발생 현황(규모 2.0미만)]\n2025/12/25 05:14:43 경남 밀양시 동쪽 15km 지역 (규모:1.5 / 깊이:8km)',
    );

    const repeated = await source.run(result.nextState);
    expect(repeated.events).toHaveLength(0);
    expect(repeated.nextState).toBe(result.nextState);
  });

  it('should handle missing depth and whitespace variations', async () => {
    const html = '<p class="p_hypen">2025/12/15 20:25:23 전남 신안군 북서쪽 36km 해역 (규모 : 1.5)</p>';

    const fetchMock = vi.fn().mockImplementation(() => Promise.resolve(new Response(html, { status: 200 })));
    vi.stubGlobal('fetch', fetchMock);

    const source = new KmaMicroEarthquakeSource();
    const result = await source.run(null);

    expect(result.events).toHaveLength(1);
    expect(result.events[0].title).toBe('전남 신안군 북서쪽 36km 해역 규모 1.5 미소지진');
    expect(result.events[0].occurredAt).toBe('2025-12-15T11:25:23.000Z');
    expect(result.events[0].payload?.depthKm).toBeNull();
  });

  it('should parse even with prefix or suffix text', async () => {
    const html = '<p class="p_hypen">기상청 발표: 2025/12/15 20:25:23 전남 신안군 북서쪽 36km 해역 (규모:1.0) 참고</p>';

    const fetchMock = vi.fn().mockImplementation(() => Promise.resolve(new Response(html, { status: 200 })));
    vi.stubGlobal('fetch', fetchMock);

    const source = new KmaMicroEarthquakeSource();
    const result = await source.run(null);

    expect(result.events).toHaveLength(1);
    expect(result.events[0].title).toBe('전남 신안군 북서쪽 36km 해역 규모 1.0 미소지진');
    expect(result.events[0].regionText).toBe('전남 신안군 북서쪽 36km 해역');
    expect(result.events[0].occurredAt).toBe('2025-12-15T11:25:23.000Z');
  });
});
