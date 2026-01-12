import { z } from 'zod';

export const schemaGetEventsStreamClientsResBody = z.object({
  total: z.number().int().min(0),
});

export type GetEventsStreamClientsResBody = z.infer<typeof schemaGetEventsStreamClientsResBody>;
