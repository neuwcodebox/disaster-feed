import { z } from 'zod';

export const schemaGetEventsMetricsQuery = z.object({
  limit: z.coerce.number().int().positive().max(2000).optional(),
  kind: z.coerce.number().int().optional(),
  source: z.coerce.number().int().optional(),
  since: z.iso.datetime().optional(),
});

export type GetEventsMetricsQueryDto = z.infer<typeof schemaGetEventsMetricsQuery>;
