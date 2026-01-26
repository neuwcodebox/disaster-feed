import { z } from 'zod';

const schemaGeo = z.object({
  lat: z.number(),
  lng: z.number(),
});

const schemaRegionCode = z.string().regex(/^\d{10}$/);

export const schemaEvent = z.object({
  id: z.string(),
  source: z.number().int(),
  kind: z.number().int(),
  title: z.string(),
  body: z.string().optional(),
  fetchedAt: z.string(),
  occurredAt: z.string().nullable(),
  regionText: z.string().optional(),
  geo: schemaGeo.optional(),
  regionCodes: z.array(schemaRegionCode).optional(),
  level: z.number().int(),
});

export type EventDto = z.infer<typeof schemaEvent>;
export const schemaGetEventsResBody = z.array(schemaEvent);
