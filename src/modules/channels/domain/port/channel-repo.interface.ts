import type { NewOutboundChannel, OutboundChannel } from '../entity/outbound-channel.entity';

export interface IOutboundChannelRepository {
  listChannels(): Promise<OutboundChannel[]>;
  getChannelById(id: string): Promise<OutboundChannel | undefined>;
  insertChannel(data: NewOutboundChannel, id: string): Promise<OutboundChannel>;
  updateChannel(id: string, data: NewOutboundChannel): Promise<OutboundChannel | undefined>;
  deleteChannel(id: string): Promise<boolean>;
}
