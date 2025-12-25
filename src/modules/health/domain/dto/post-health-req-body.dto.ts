import { z } from '@hono/zod-openapi';

export const schemaPostHealthReqBody = z.object({
  message: z.string().nullable().openapi({ example: 'Hello' }),
});

export type PostHealthReqBodyDto = z.infer<typeof schemaPostHealthReqBody>;
