import { z } from 'zod';

export const schemaDeleteChannelResBody = z.object({
  deleted: z.boolean(),
});

export type DeleteChannelResBodyDto = z.infer<typeof schemaDeleteChannelResBody>;
