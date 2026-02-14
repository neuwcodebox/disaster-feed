import type { ResponseUsage } from 'openai/resources/responses/responses';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';

const mockParse = vi.fn();
const mockGenerationUpdate = vi.fn();

vi.mock('@/core/env', () => {
  return {
    env: {
      OPENAI_API_KEY: 'test-openai-key',
    },
  };
});

vi.mock('openai', () => {
  class OpenAI {
    public responses = {
      parse: mockParse,
    };
  }

  return { default: OpenAI };
});

vi.mock('@langfuse/tracing', () => {
  return {
    startActiveObservation: async (
      _name: string,
      callback: (generation: { update: (attributes: unknown) => void }) => Promise<unknown>,
    ) => {
      return await callback({ update: mockGenerationUpdate });
    },
  };
});

import { OpenAiLlmClient } from './openai-llm-client';

describe('OpenAiLlmClient', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('should send Langfuse-compatible usageDetails keys for token tracking', async () => {
    const usage: ResponseUsage = {
      input_tokens: 120,
      output_tokens: 40,
      total_tokens: 160,
      input_tokens_details: {
        cached_tokens: 20,
      },
      output_tokens_details: {
        reasoning_tokens: 10,
      },
    };

    mockParse.mockResolvedValue({
      id: 'resp_test_1',
      status: 'completed',
      _request_id: 'req_test_1',
      output: [],
      output_parsed: { label: '호우' },
      usage,
    });

    const client = new OpenAiLlmClient();
    await client.parseJson({
      model: 'gpt-4.1-mini',
      schemaName: 'schemaDisasterLabel',
      schema: z.object({
        label: z.string(),
      }),
      messages: [
        { role: 'system', content: '분류기' },
        { role: 'user', content: '태풍 특보' },
      ],
    });

    const lastUpdate = mockGenerationUpdate.mock.calls.at(-1)?.[0] as
      | {
          usageDetails?: Record<string, number>;
        }
      | undefined;

    expect(lastUpdate?.usageDetails).toEqual({
      input: 120,
      output: 40,
      total: 160,
      input_cached_tokens: 20,
      output_reasoning_tokens: 10,
    });
  });
});
