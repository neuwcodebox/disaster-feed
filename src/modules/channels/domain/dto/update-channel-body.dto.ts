import type { z } from 'zod';
import { schemaOutboundChannelInput } from './channel.schema';

export const schemaUpdateChannelBody = schemaOutboundChannelInput;
export type UpdateChannelBodyDto = z.infer<typeof schemaUpdateChannelBody>;
