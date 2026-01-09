import { z } from 'zod';

export const schemaEventMetric = z.object({
  id: z.string(),
  source: z.number().int(),
  kind: z.number().int(),
  occurredAt: z.string().nullable(),
  level: z.number().int(),
});

export type EventMetricDto = z.infer<typeof schemaEventMetric>;
export const schemaGetEventsMetricsResBody = z.array(schemaEventMetric);
