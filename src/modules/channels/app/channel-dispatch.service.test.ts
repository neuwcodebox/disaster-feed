import { afterEach, describe, expect, it, vi } from 'vitest';
import { ChannelKinds } from '../domain/channel.enums';
import type { OutboundChannel } from '../domain/entity/outbound-channel.entity';
import type { IOutboundChannelRepository } from '../domain/port/channel-repo.interface';
import { OutboundChannelDispatchService } from './channel-dispatch.service';

class FakeOutboundChannelRepository implements IOutboundChannelRepository {
  constructor(private readonly channels: OutboundChannel[]) {}

  public async listChannels(): Promise<OutboundChannel[]> {
    return this.channels;
  }

  public async getChannelById(): Promise<OutboundChannel | undefined> {
    throw new Error('not implemented');
  }

  public async insertChannel(): Promise<OutboundChannel> {
    throw new Error('not implemented');
  }

  public async updateChannel(): Promise<OutboundChannel | undefined> {
    throw new Error('not implemented');
  }

  public async deleteChannel(): Promise<boolean> {
    throw new Error('not implemented');
  }
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('OutboundChannelDispatchService', () => {
  it('sends discord webhook for matching min level', async () => {
    const channels: OutboundChannel[] = [
      {
        id: 'channel-1',
        kind: ChannelKinds.Discord,
        minLevel: 3,
        target: 'https://discord.example/1',
      },
      {
        id: 'channel-2',
        kind: ChannelKinds.Discord,
        minLevel: 4,
        target: 'https://discord.example/2',
      },
    ];

    const repository = new FakeOutboundChannelRepository(channels);
    const service = new OutboundChannelDispatchService(repository);

    const response = {
      ok: true,
      status: 204,
      text: async () => '',
    } as Response;

    const fetchMock = vi.fn(async () => response);
    vi.stubGlobal('fetch', fetchMock);

    await service.dispatchEvent({
      id: 'event-1',
      title: 'Test event',
      body: null,
      level: 3,
      source: 1,
      kind: 1,
      fetchedAt: '2024-01-01T00:00:00Z',
      occurredAt: null,
      regionText: null,
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledWith(
      'https://discord.example/1',
      expect.objectContaining({
        method: 'POST',
      }),
    );
  });
});
