import { z } from 'zod';

export const schemaGetEventsQuery = z.object({
  limit: z.coerce.number().int().positive().max(200).optional(),
  kind: z.coerce.number().int().optional(),
  source: z.coerce.number().int().optional(),
});

export type GetEventsQueryDto = z.infer<typeof schemaGetEventsQuery>;
