import { z } from 'zod';

export const schemaEvent = z.object({
  id: z.string(),
  source: z.string(),
  kind: z.number().int(),
  title: z.string(),
  fetchedAt: z.string(),
  occurredAt: z.string().nullable(),
  regionText: z.string().nullable(),
  level: z.string().nullable(),
  link: z.string().nullable(),
  payload: z.record(z.string(), z.unknown()).nullable(),
});

export type EventDto = z.infer<typeof schemaEvent>;
export const schemaGetEventsResBody = z.array(schemaEvent);
