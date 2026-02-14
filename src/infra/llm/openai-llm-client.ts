import { startActiveObservation } from '@langfuse/tracing';
import OpenAI from 'openai';
import { zodTextFormat } from 'openai/helpers/zod';
import type { ParsedResponseOutputItem, ResponseUsage } from 'openai/resources/responses/responses';
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
    const client = this.client;

    if (!client) {
      return { parsed: null, refusal: null, reasoningSummary: [], requestId: null };
    }

    return await startActiveObservation(
      options.observationName ?? 'openai.responses.parse',
      async (generation) => {
        generation.update({
          input: options.messages,
          model: options.model,
          modelParameters: buildModelParameters(options),
          metadata: { schemaName: options.schemaName },
        });

        try {
          const reasoning = buildReasoningOptions(options);
          const response = await client.responses.parse(
            {
              model: options.model,
              input: toResponseInput(options.messages),
              text: { format: zodTextFormat(options.schema, options.schemaName) },
              ...(reasoning ? { reasoning } : {}),
            },
            { timeout: options.timeoutMs ?? 30000 },
          );

          const reasoningSummary = extractReasoningSummary(response.output);
          const result: LlmJsonParseResult<T> = {
            parsed: response.output_parsed ?? null,
            refusal: extractRefusal(response.output),
            reasoningSummary,
            requestId: response._request_id ?? null,
          };

          generation.update({
            output: {
              parsed: result.parsed,
              refusal: result.refusal,
              reasoningSummary: result.reasoningSummary,
              responseId: response.id,
            },
            usageDetails: buildUsageDetails(response.usage),
            metadata: {
              schemaName: options.schemaName,
              responseId: response.id,
              requestId: response._request_id ?? null,
              status: response.status,
            },
          });

          return result;
        } catch (error) {
          generation.update({
            level: 'ERROR',
            statusMessage: 'OpenAI structured output request failed',
            output: { error: toErrorMessage(error) },
          });
          throw error;
        }
      },
      { asType: 'generation' },
    );
  }
}

function toResponseInput(
  messages: LlmJsonParseOptions<unknown>['messages'],
): Array<{ role: 'system' | 'user'; content: string }> {
  const input: Array<{ role: 'system' | 'user'; content: string }> = [];

  for (const message of messages) {
    input.push({ role: message.role, content: message.content });
  }

  return input;
}

function buildReasoningOptions(options: LlmJsonParseOptions<unknown>):
  | {
      effort?: 'low' | 'medium' | 'high';
      summary?: 'auto' | 'concise' | 'detailed';
    }
  | undefined {
  const reasoning: {
    effort?: 'low' | 'medium' | 'high';
    summary?: 'auto' | 'concise' | 'detailed';
  } = {};

  if (options.reasoningEffort) {
    reasoning.effort = options.reasoningEffort;
  }
  if (options.reasoningSummary) {
    reasoning.summary = options.reasoningSummary;
  }

  if (Object.keys(reasoning).length === 0) {
    return undefined;
  }

  return reasoning;
}

function extractRefusal(output: Array<ParsedResponseOutputItem<unknown>>): string | null {
  for (const outputItem of output) {
    if (outputItem.type !== 'message') {
      continue;
    }

    for (const contentItem of outputItem.content) {
      if (contentItem.type === 'refusal') {
        return contentItem.refusal;
      }
    }
  }

  return null;
}

function extractReasoningSummary(output: Array<ParsedResponseOutputItem<unknown>>): string[] {
  const summaryTexts: string[] = [];

  for (const outputItem of output) {
    if (outputItem.type !== 'reasoning') {
      continue;
    }

    for (const summaryItem of outputItem.summary) {
      if (summaryItem.type === 'summary_text') {
        summaryTexts.push(summaryItem.text);
      }
    }
  }

  return summaryTexts;
}

function buildUsageDetails(usage: ResponseUsage | undefined): Record<string, number> | undefined {
  if (!usage) {
    return undefined;
  }

  const cachedTokens = usage.input_tokens_details.cached_tokens;
  const reasoningTokens = usage.output_tokens_details.reasoning_tokens;

  return {
    input: usage.input_tokens,
    output: usage.output_tokens,
    total: usage.total_tokens,
    input_cached_tokens: cachedTokens,
    output_reasoning_tokens: reasoningTokens,
  };
}

function buildModelParameters(options: LlmJsonParseOptions<unknown>): { [key: string]: string | number } | undefined {
  const modelParameters: { [key: string]: string | number } = {};

  if (options.reasoningEffort) {
    modelParameters.reasoningEffort = options.reasoningEffort;
  }
  if (options.reasoningSummary) {
    modelParameters.reasoningSummary = options.reasoningSummary;
  }
  if (options.timeoutMs) {
    modelParameters.timeoutMs = options.timeoutMs;
  }

  if (Object.keys(modelParameters).length === 0) {
    return undefined;
  }

  return modelParameters;
}

function toErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }

  return 'Unknown error';
}
