import { afterEach, describe, expect, it, vi } from 'vitest';
import { EventLevels } from '@/modules/events/domain/event.enums';
import { KpxPowerSupplySource } from './kpx-power-supply.source';

describe('KpxPowerSupplySource', () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('should store initial stage without emitting events', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2025-01-02T00:00:00.000Z'));

    const html = '<div class="title">전력수급</div><div class="step">정상</div>';
    const fetchMock = vi.fn().mockImplementation(() => Promise.resolve(new Response(html, { status: 200 })));
    vi.stubGlobal('fetch', fetchMock);

    const source = new KpxPowerSupplySource();
    const result = await source.run(null);

    expect(result.events).toHaveLength(0);
    expect(result.nextState).toContain('"stage":"정상"');
  });

  it('should emit event when stage increases', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2025-01-02T01:00:00.000Z'));

    const html = '<div class="title">전력수급</div><div class="step">관심 단계</div>';
    const fetchMock = vi.fn().mockImplementation(() => Promise.resolve(new Response(html, { status: 200 })));
    vi.stubGlobal('fetch', fetchMock);

    const previousState = JSON.stringify({ stage: '정상', confirmedAt: '2025-01-01T00:00:00.000Z' });
    const source = new KpxPowerSupplySource();
    const result = await source.run(previousState);

    expect(result.events).toHaveLength(1);
    expect(result.events[0].title).toBe('전력수급현황 정상→관심 상향');
    expect(result.events[0].level).toBe(EventLevels.Minor);
    expect(result.events[0].payload?.direction).toBe('up');
  });

  it('should delay downgrade events within the grace period', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2025-01-02T01:30:00.000Z'));

    const html = '<div class="title">전력수급</div><div class="step">주의</div>';
    const fetchMock = vi.fn().mockImplementation(() => Promise.resolve(new Response(html, { status: 200 })));
    vi.stubGlobal('fetch', fetchMock);

    const previousState = JSON.stringify({ stage: '경계', confirmedAt: '2025-01-02T01:00:00.000Z' });
    const source = new KpxPowerSupplySource();
    const result = await source.run(previousState);

    expect(result.events).toHaveLength(0);
    expect(result.nextState).toBe(previousState);
  });
});
