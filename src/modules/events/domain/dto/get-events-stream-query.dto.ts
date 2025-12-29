import { z } from 'zod';

export const schemaGetEventsStreamQuery = z.object({
  afterId: z.uuid().optional(),
});

export type GetEventsStreamQueryDto = z.infer<typeof schemaGetEventsStreamQuery>;
