import type { Redis } from 'ioredis';
import { describe, expect, it } from 'vitest';
import type { IEventRepository } from '../domain/port/event-repo.interface';
import { EventStreamService } from './event-stream.service';

class FakeRedis {
  private index = 0;

  constructor(
    private readonly scanBatches: Array<[string, string[]]>,
    private readonly values: Map<string, string | null>,
  ) {}

  public async scan(_cursor: string, ..._args: string[]): Promise<[string, string[]]> {
    const batch = this.scanBatches[this.index] ?? ['0', []];
    this.index += 1;
    return batch;
  }

  public async mget(...keys: string[]): Promise<(string | null)[]> {
    const results: Array<string | null> = [];
    for (const key of keys) {
      results.push(this.values.get(key) ?? null);
    }
    return results;
  }

  public async set(): Promise<'OK'> {
    return 'OK';
  }

  public async del(): Promise<number> {
    return 1;
  }
}

function createEventRepositoryStub(): IEventRepository {
  return {
    insertEvent: async () => {
      throw new Error('not implemented');
    },
    getEventById: async () => undefined,
    listEvents: async () => [],
    listEventsAfterId: async () => [],
    listLatestFetchedAtBySources: async () => [],
  };
}

describe('EventStreamService', () => {
  it('sums Redis client counts across instances', async () => {
    const keys = ['sse:clients:a', 'sse:clients:b'];
    const values = new Map<string, string | null>([
      [keys[0], '2'],
      [keys[1], '3'],
    ]);
    const redisClient = new FakeRedis([['0', keys]], values);
    const redisSubscriber = {} as unknown as Redis;
    const eventRepository = createEventRepositoryStub();
    const service = new EventStreamService(eventRepository, redisClient as unknown as Redis, redisSubscriber);

    const total = await service.getApproxClientCount();

    expect(total).toBe(5);
  });
});
