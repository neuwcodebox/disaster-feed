import { z } from 'zod';

export const schemaGetEventsStreamQuery = z.object({
  since: z.iso.datetime().optional(),
});

export type GetEventsStreamQueryDto = z.infer<typeof schemaGetEventsStreamQuery>;
