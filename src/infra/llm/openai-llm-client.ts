import OpenAI from 'openai';
import { zodResponseFormat } from 'openai/helpers/zod';
import { env } from '@/core/env';
import type { LlmJsonClient, LlmJsonParseOptions, LlmJsonParseResult } from './llm-client.interface';

export class OpenAiLlmClient implements LlmJsonClient {
  private readonly client: OpenAI | null;

  constructor() {
    this.client = env.OPENAI_API_KEY ? new OpenAI({ apiKey: env.OPENAI_API_KEY }) : null;
  }

  public isEnabled(): boolean {
    return this.client !== null;
  }

  public async parseJson<T>(options: LlmJsonParseOptions<T>): Promise<LlmJsonParseResult<T>> {
    if (!this.client) {
      return { parsed: null, refusal: null };
    }

    const completion = await this.client.chat.completions.parse(
      {
        model: options.model,
        messages: options.messages,
        response_format: zodResponseFormat(options.schema, options.schemaName),
      },
      { timeout: options.timeoutMs ?? 30000 },
    );

    const message = completion.choices[0]?.message;

    return {
      parsed: message?.parsed ?? null,
      refusal: message?.refusal ?? null,
    };
  }
}
