import { z } from 'zod';

export const schemaGetChannelParams = z.object({
  id: z.uuid(),
});

export type GetChannelParamsDto = z.infer<typeof schemaGetChannelParams>;
