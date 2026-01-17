import { describe, expect, it, vi } from 'vitest';
import type { Event } from '@/modules/events/domain/entity/event.entity';
import type { IEventRepository } from '@/modules/events/domain/port/event-repo.interface';
import type { IOutboundChannelDispatcher } from '../domain/port/channel-dispatcher.interface';
import { handleOutboundDispatchJob } from './outbound-dispatch-worker.service';

function createEventRepositoryStub(event: Event | undefined): IEventRepository {
  return {
    insertEvent: async () => {
      throw new Error('not implemented');
    },
    getEventById: async () => event,
    listEvents: async () => [],
    listEventMetrics: async () => [],
    listEventsAfterId: async () => [],
    listLatestFetchedAtBySources: async () => [],
  };
}

describe('handleOutboundDispatchJob', () => {
  it('dispatches when event exists', async () => {
    const event = {
      id: 'event-1',
      title: 'Test',
      body: 'Body',
      level: 3,
      source: 1,
      kind: 2,
      fetchedAt: '2024-01-01T00:00:00Z',
      occurredAt: null,
      regionText: null,
      geo: null,
      regionCodes: null,
      payload: null,
    };

    const repository = createEventRepositoryStub(event);
    const dispatcher: IOutboundChannelDispatcher = {
      dispatchEvent: vi.fn(async () => undefined),
    };

    await handleOutboundDispatchJob(repository, dispatcher, { eventId: 'event-1' });

    expect(dispatcher.dispatchEvent).toHaveBeenCalledTimes(1);
    expect(dispatcher.dispatchEvent).toHaveBeenCalledWith({
      id: 'event-1',
      title: 'Test',
      body: 'Body',
      level: 3,
      source: 1,
      kind: 2,
      fetchedAt: '2024-01-01T00:00:00Z',
      occurredAt: null,
      regionText: null,
    });
  });

  it('skips when event is missing', async () => {
    const repository = createEventRepositoryStub(undefined);
    const dispatcher: IOutboundChannelDispatcher = {
      dispatchEvent: vi.fn(async () => undefined),
    };

    await handleOutboundDispatchJob(repository, dispatcher, { eventId: 'missing' });

    expect(dispatcher.dispatchEvent).not.toHaveBeenCalled();
  });
});
