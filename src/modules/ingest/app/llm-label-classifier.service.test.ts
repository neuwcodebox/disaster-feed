import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { LlmJsonParseOptions, LlmJsonParseResult } from '@/infra/llm/llm-client.interface';
import { LlmLabelClassifierService } from './llm-label-classifier.service';

type MockedLlmClient = {
  isEnabled: ReturnType<typeof vi.fn<() => boolean>>;
  parseJson: ReturnType<typeof vi.fn<(options: LlmJsonParseOptions<unknown>) => Promise<LlmJsonParseResult<unknown>>>>;
};

let openAiClientMock: MockedLlmClient;

function createOpenAiClientMock(): MockedLlmClient {
  return {
    isEnabled: vi.fn(() => true),
    parseJson: vi.fn(),
  };
}

vi.mock('@/infra/llm/openai-llm-client', () => {
  class OpenAiLlmClient {
    public isEnabled(): boolean {
      return openAiClientMock.isEnabled();
    }

    public parseJson<T>(options: LlmJsonParseOptions<T>): Promise<LlmJsonParseResult<T>> {
      return openAiClientMock.parseJson(options as LlmJsonParseOptions<unknown>) as Promise<LlmJsonParseResult<T>>;
    }
  }

  return { OpenAiLlmClient };
});

describe('LlmLabelClassifierService', () => {
  beforeEach(() => {
    openAiClientMock = createOpenAiClientMock();
    vi.clearAllMocks();
  });

  it('should return null when client is disabled', async () => {
    openAiClientMock.isEnabled.mockReturnValue(false);

    const service = new LlmLabelClassifierService();
    const labels = ['기타', '호우'] as const;
    const result = await service.classifyBatch({
      labels,
      items: [{ id: '1', text: '테스트' }],
    });

    expect(openAiClientMock.isEnabled).toHaveBeenCalled();
    expect(openAiClientMock.parseJson).not.toHaveBeenCalled();
    expect(result).toBeNull();
  });

  it('should return empty map when items are empty', async () => {
    const service = new LlmLabelClassifierService();
    const labels = ['기타', '호우'] as const;
    const result = await service.classifyBatch({
      labels,
      items: [],
    });

    expect(openAiClientMock.isEnabled).toHaveBeenCalled();
    expect(openAiClientMock.parseJson).not.toHaveBeenCalled();
    expect(result).toBeInstanceOf(Map);
    expect(result?.size).toBe(0);
  });

  it('should map labels from parsed results', async () => {
    openAiClientMock.parseJson.mockResolvedValue({
      parsed: { items: [{ id: 'a', label: '호우' }] },
      refusal: null,
    });

    const service = new LlmLabelClassifierService();
    const labels = ['기타', '호우'] as const;
    const result = await service.classifyBatch({
      labels,
      items: [{ id: 'a', text: '호우 주의' }],
    });

    expect(openAiClientMock.parseJson).toHaveBeenCalledTimes(1);
    expect(result?.get('a')).toBe('호우');
  });

  it('should use default timeout', async () => {
    openAiClientMock.parseJson.mockResolvedValue({
      parsed: { items: [{ id: 'a', label: '호우' }] },
      refusal: null,
    });

    const service = new LlmLabelClassifierService();
    const labels = ['기타', '호우'] as const;
    await service.classifyBatch({
      labels,
      items: [{ id: 'a', text: '호우 주의' }],
    });

    expect(openAiClientMock.parseJson).toHaveBeenCalledWith(
      expect.objectContaining({
        timeoutMs: 20000,
      }),
    );
  });

  it('should override timeout when option is provided', async () => {
    openAiClientMock.parseJson.mockResolvedValue({
      parsed: { items: [{ id: 'a', label: '호우' }] },
      refusal: null,
    });

    const service = new LlmLabelClassifierService({ timeoutMs: 1200 });
    const labels = ['기타', '호우'] as const;
    await service.classifyBatch({
      labels,
      items: [{ id: 'a', text: '호우 주의' }],
    });

    expect(openAiClientMock.parseJson).toHaveBeenCalledWith(
      expect.objectContaining({
        timeoutMs: 1200,
      }),
    );
  });

  it('should return partial results when a chunk fails', async () => {
    openAiClientMock.parseJson
      .mockResolvedValueOnce({
        parsed: { items: [{ id: '1', label: '호우' }] },
        refusal: null,
      })
      .mockResolvedValueOnce({
        parsed: null,
        refusal: null,
      });

    const service = new LlmLabelClassifierService({ batchSize: 1, maxConcurrency: 1 });
    const labels = ['기타', '호우', '한파'] as const;
    const result = await service.classifyBatch({
      labels,
      items: [
        { id: '1', text: '호우 주의' },
        { id: '2', text: '한파 주의' },
      ],
    });

    expect(openAiClientMock.parseJson).toHaveBeenCalledTimes(2);
    expect(result?.size).toBe(1);
    expect(result?.get('1')).toBe('호우');
  });
});
