import type { z } from 'zod';
import { schemaOutboundChannelInput } from './channel.schema';

export const schemaCreateChannelBody = schemaOutboundChannelInput;
export type CreateChannelBodyDto = z.infer<typeof schemaCreateChannelBody>;
