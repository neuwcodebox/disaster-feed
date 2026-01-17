import type { NewOutboundChannel, OutboundChannel } from '../entity/outbound-channel.entity';

export interface IOutboundChannelService {
  listChannels(): Promise<OutboundChannel[]>;
  getChannelById(id: string): Promise<OutboundChannel | undefined>;
  createChannel(data: NewOutboundChannel): Promise<OutboundChannel>;
  updateChannel(id: string, data: NewOutboundChannel): Promise<OutboundChannel | undefined>;
  deleteChannel(id: string): Promise<boolean>;
}
