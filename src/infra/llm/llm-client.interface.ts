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
};

export type LlmJsonParseResult<T> = {
  parsed: T | null;
  refusal: string | null;
};

export interface LlmJsonClient {
  isEnabled(): boolean;
  parseJson<T>(options: LlmJsonParseOptions<T>): Promise<LlmJsonParseResult<T>>;
}
