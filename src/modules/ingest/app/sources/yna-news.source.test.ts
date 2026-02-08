import { afterEach, describe, expect, it, vi } from 'vitest';
import { EventKinds } from '@/modules/events/domain/event.enums';
import type { LlmLabelClassifierService } from '../llm-label-classifier.service';

describe('YnaNewsSource', () => {
  afterEach(() => {
    delete process.env.YNA_SERVICE_KEY;
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('should classify and emit news events', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2025-01-02T03:00:00.000Z'));

    process.env.YNA_SERVICE_KEY = 'test-key';
    vi.resetModules();
    const { YnaNewsSource } = await import('./yna-news.source');

    const responseBody = {
      header: { resultCode: '00', resultMsg: 'OK' },
      numOfRows: 1,
      pageNo: 1,
      totalCount: 1,
      body: [
        {
          YNA_NO: 123,
          YNA_TTL: '호우로 인한 침수 발생',
          YNA_CN: '침수 피해가 보고되었습니다.',
          YNA_YMD: '20250102',
          CRT_DT: '2025-01-02 11:00:00',
        },
      ],
    };

    const fetchMock = vi.fn().mockImplementation(() =>
      Promise.resolve(
        new Response(JSON.stringify(responseBody), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }),
      ),
    );
    vi.stubGlobal('fetch', fetchMock);

    const classifier = {
      isEnabled: vi.fn(() => true),
      classifyBatch: vi.fn(() => Promise.resolve(new Map([['123', '호우']]))),
    } as unknown as LlmLabelClassifierService;

    const source = new YnaNewsSource(classifier);
    const result = await source.run(null);

    expect(result.events).toHaveLength(1);
    expect(result.events[0].kind).toBe(EventKinds.Rain);
    expect(result.events[0].title).toBe('호우로 인한 침수 발생');
  });

  it('should throw when classification is unavailable', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2025-01-02T03:00:00.000Z'));

    process.env.YNA_SERVICE_KEY = 'test-key';
    vi.resetModules();
    const { YnaNewsSource } = await import('./yna-news.source');

    const responseBody = {
      header: { resultCode: '00', resultMsg: 'OK' },
      numOfRows: 1,
      pageNo: 1,
      totalCount: 1,
      body: [
        {
          YNA_NO: 124,
          YNA_TTL: '호우로 인한 침수 발생',
          YNA_CN: '침수 피해가 보고되었습니다.',
          YNA_YMD: '20250102',
          CRT_DT: '2025-01-02 11:00:00',
        },
      ],
    };

    const fetchMock = vi.fn().mockImplementation(() =>
      Promise.resolve(
        new Response(JSON.stringify(responseBody), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }),
      ),
    );
    vi.stubGlobal('fetch', fetchMock);

    const classifier = {
      isEnabled: vi.fn(() => true),
      classifyBatch: vi.fn(() => Promise.resolve(null)),
    } as unknown as LlmLabelClassifierService;

    const source = new YnaNewsSource(classifier);
    await expect(source.run(null)).rejects.toThrow('LLM label classification failed');
  });
});
