import { z } from '@hono/zod-openapi';

export const schemaGetPingResBody = z.object({
  ok: z.boolean().openapi({ example: true }),
  timestamp: z.number().describe('Timestamp(ms)'),
});

export type GetPingResBodyDto = z.infer<typeof schemaGetPingResBody>;
