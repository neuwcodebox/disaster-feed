import { z } from 'zod';
import { schemaOutboundChannel } from './channel.schema';

export const schemaGetChannelsResBody = z.array(schemaOutboundChannel);
export type OutboundChannelDto = z.infer<typeof schemaOutboundChannel>;
