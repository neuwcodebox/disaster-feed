import { z } from 'zod';

export const schemaGetEventsQuery = z.object({
  limit: z.coerce.number().int().positive().max(200).optional(),
  kind: z.coerce.number().int().optional(),
  source: z.string().min(1).optional(),
});

export type GetEventsQueryDto = z.infer<typeof schemaGetEventsQuery>;
