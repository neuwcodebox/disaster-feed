import { z } from '@hono/zod-openapi';

export const schemaPostHealthResBody = z.object({
  id: z.number(),
  message: z.string().nullable().openapi({ example: 'Hi' }),
  createdAt: z.number().describe('Timestamp(ms)'),
});

export type PostHealthResBodyDto = z.infer<typeof schemaPostHealthResBody>;
