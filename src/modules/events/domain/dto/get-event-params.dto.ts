import { z } from 'zod';

export const schemaGetEventParams = z.object({
  id: z.string().uuid(),
});

export type GetEventParamsDto = z.infer<typeof schemaGetEventParams>;
