import type { ZodType } from 'zod';

export type LlmChatMessage = {
  role: 'system' | 'user';
  content: string;
};

export type LlmJsonParseOptions<T> = {
  model: string;
  messages: LlmChatMessage[];
  schema: ZodType<T>;
  schemaName: string;
  timeoutMs?: number;
  reasoningEffort?: 'low' | 'medium' | 'high';
  reasoningSummary?: 'auto' | 'concise' | 'detailed';
  observationName?: string;
};

export type LlmJsonParseResult<T> = {
  parsed: T | null;
  refusal: string | null;
  reasoningSummary?: string[];
  requestId?: string | null;
};

export interface LlmJsonClient {
  isEnabled(): boolean;
  parseJson<T>(options: LlmJsonParseOptions<T>): Promise<LlmJsonParseResult<T>>;
}
