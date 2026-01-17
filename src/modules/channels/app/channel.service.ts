import { inject, injectable } from 'inversify';
import { createUuidV7 } from '@/core/uuid';
import { ChannelDeps } from '../domain/dep/channel.dep';
import type { NewOutboundChannel, OutboundChannel } from '../domain/entity/outbound-channel.entity';
import type { IOutboundChannelRepository } from '../domain/port/channel-repo.interface';
import type { IOutboundChannelService } from '../domain/port/channel-service.interface';

@injectable()
export class OutboundChannelService implements IOutboundChannelService {
  constructor(
    @inject(ChannelDeps.ChannelRepo)
    private readonly channelRepository: IOutboundChannelRepository,
  ) {}

  public async listChannels(): Promise<OutboundChannel[]> {
    return this.channelRepository.listChannels();
  }

  public async getChannelById(id: string): Promise<OutboundChannel | undefined> {
    return this.channelRepository.getChannelById(id);
  }

  public async createChannel(data: NewOutboundChannel): Promise<OutboundChannel> {
    return this.channelRepository.insertChannel(data, createUuidV7());
  }

  public async updateChannel(id: string, data: NewOutboundChannel): Promise<OutboundChannel | undefined> {
    return this.channelRepository.updateChannel(id, data);
  }

  public async deleteChannel(id: string): Promise<boolean> {
    return this.channelRepository.deleteChannel(id);
  }
}
