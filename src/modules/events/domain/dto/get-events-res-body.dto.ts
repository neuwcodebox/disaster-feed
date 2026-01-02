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
  body: z.string().nullable(),
  fetchedAt: z.string(),
  occurredAt: z.string().nullable(),
  regionText: z.string().nullable(),
  geo: schemaGeo.nullable(),
  regionCodes: z.array(schemaRegionCode).nullable(),
  level: z.number().int(),
  payload: z.record(z.string(), z.unknown()).nullable(),
});

export type EventDto = z.infer<typeof schemaEvent>;
export const schemaGetEventsResBody = z.array(schemaEvent);
