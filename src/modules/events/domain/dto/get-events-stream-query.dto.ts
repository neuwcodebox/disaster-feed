import { z } from 'zod';

export const schemaGetEventsStreamQuery = z.object({
  since: z.string().datetime().optional(),
});

export type GetEventsStreamQueryDto = z.infer<typeof schemaGetEventsStreamQuery>;
