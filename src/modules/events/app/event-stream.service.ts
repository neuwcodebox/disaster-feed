import { randomUUID } from 'node:crypto';
import type { SSEStreamingApi } from 'hono/streaming';
import { inject, injectable } from 'inversify';
import type { Redis } from 'ioredis';
import { logger } from '@/core/logger';
import { subscribeNewEvents } from '@/infra/redis/pubsub';
import { RedisDeps } from '@/infra/redis/redis.dep';
import { EventDeps } from '../domain/dep/event.dep';
import type { Event } from '../domain/entity/event.entity';
import type { IEventRepository } from '../domain/port/event-repo.interface';
import { toEventDto } from './event.mapper';

const SSE_CLIENT_KEY_PREFIX = 'sse:clients:';
const SSE_CLIENT_TTL_SEC = 45;
const SSE_CLIENT_HEARTBEAT_SEC = 15;

@injectable()
export class EventStreamService {
  private readonly clients = new Set<SSEStreamingApi>();
  private readonly instanceId = randomUUID();
  private heartbeatTimer: NodeJS.Timeout | null = null;
  private started = false;
  private unsubscribe: (() => Promise<void>) | null = null;

  constructor(
    @inject(EventDeps.EventRepo)
    private readonly eventRepository: IEventRepository,
    @inject(RedisDeps.Client)
    private readonly redisClient: Redis,
    @inject(RedisDeps.Subscriber)
    private readonly redisSubscriber: Redis,
  ) {}

  public async start(): Promise<void> {
    if (this.started) {
      return;
    }

    logger.debug('Starting event stream subscriber');
    this.started = true;
    this.startClientHeartbeat();
    void this.updateRedisClientCount();

    try {
      this.unsubscribe = await subscribeNewEvents(this.redisSubscriber, async (eventId) => {
        await this.handleNewEvent(eventId);
      });
      logger.debug('Subscribed to new event channel');
    } catch (error) {
      this.started = false;
      this.stopClientHeartbeat();
      await this.removeRedisClientCount();
      logger.error({ error }, 'Failed to start event stream service');
    }
  }

  public async stop(): Promise<void> {
    if (!this.started) {
      return;
    }

    this.started = false;

    if (this.unsubscribe) {
      try {
        await this.unsubscribe();
        logger.debug('Unsubscribed from new event channel');
      } catch (error) {
        logger.warn({ error }, 'Failed to unsubscribe event stream');
      } finally {
        this.unsubscribe = null;
      }
    }

    this.clients.clear();
    this.stopClientHeartbeat();
    await this.removeRedisClientCount();
    logger.debug('Event stream stopped');
  }

  public addClient(stream: SSEStreamingApi): void {
    this.clients.add(stream);
    logger.debug({ clientCount: this.clients.size }, 'SSE client connected');
    void this.updateRedisClientCount();

    stream.onAbort(() => {
      this.clients.delete(stream);
      logger.debug({ clientCount: this.clients.size }, 'SSE client disconnected');
      void this.updateRedisClientCount();
    });
  }

  public async sendCatchUp(stream: SSEStreamingApi, afterId?: string): Promise<void> {
    if (!afterId) {
      return;
    }

    logger.debug({ afterId }, 'Sending SSE catch-up events');
    const events = await this.eventRepository.listEventsAfterId({ afterId });
    for (const event of events) {
      await stream.writeSSE({ data: JSON.stringify(toEventDto(event)), id: event.id });
    }
    logger.debug({ count: events.length, afterId }, 'Completed SSE catch-up events');
  }

  public async getApproxClientCount(): Promise<number> {
    const keys = await this.scanClientKeys();
    if (keys.length === 0) {
      return 0;
    }

    const values = await this.redisClient.mget(...keys);
    let total = 0;
    for (const value of values) {
      const parsed = Number.parseInt(value ?? '0', 10);
      if (Number.isFinite(parsed)) {
        total += parsed;
      }
    }

    return total;
  }

  private async handleNewEvent(eventId: string): Promise<void> {
    logger.debug({ eventId }, 'Received pubsub event');
    const event = await this.eventRepository.getEventById(eventId);
    if (!event) {
      logger.warn({ eventId }, 'Event not found for pubsub message');
      return;
    }

    const sentCount = await this.broadcast(event);
    logger.debug({ eventId, sentCount, clientCount: this.clients.size }, 'Broadcasted SSE event');
  }

  private async broadcast(event: Event): Promise<number> {
    const payload = JSON.stringify(toEventDto(event));
    const beforeCount = this.clients.size;
    let sentCount = 0;

    for (const client of this.clients) {
      if (client.aborted || client.closed) {
        this.clients.delete(client);
        continue;
      }

      try {
        await client.writeSSE({ data: payload, id: event.id });
        sentCount += 1;
      } catch (error) {
        this.clients.delete(client);
        logger.warn({ error }, 'Failed to broadcast SSE');
      }
    }

    if (this.clients.size !== beforeCount) {
      void this.updateRedisClientCount();
    }

    return sentCount;
  }

  private startClientHeartbeat(): void {
    if (this.heartbeatTimer) {
      return;
    }

    this.heartbeatTimer = setInterval(() => {
      void this.updateRedisClientCount();
    }, SSE_CLIENT_HEARTBEAT_SEC * 1000);
    this.heartbeatTimer.unref?.();
  }

  private stopClientHeartbeat(): void {
    if (!this.heartbeatTimer) {
      return;
    }

    clearInterval(this.heartbeatTimer);
    this.heartbeatTimer = null;
  }

  private async updateRedisClientCount(): Promise<void> {
    try {
      await this.redisClient.set(this.getClientCountKey(), `${this.clients.size}`, 'EX', SSE_CLIENT_TTL_SEC);
    } catch (error) {
      logger.warn({ error }, 'Failed to update SSE client count');
    }
  }

  private async removeRedisClientCount(): Promise<void> {
    try {
      await this.redisClient.del(this.getClientCountKey());
    } catch (error) {
      logger.warn({ error }, 'Failed to remove SSE client count');
    }
  }

  private getClientCountKey(): string {
    return `${SSE_CLIENT_KEY_PREFIX}${this.instanceId}`;
  }

  private async scanClientKeys(): Promise<string[]> {
    let cursor = '0';
    const keys: string[] = [];

    do {
      const [nextCursor, batch] = await this.redisClient.scan(
        cursor,
        'MATCH',
        `${SSE_CLIENT_KEY_PREFIX}*`,
        'COUNT',
        '100',
      );
      cursor = nextCursor;
      for (const key of batch) {
        keys.push(key);
      }
    } while (cursor !== '0');

    return keys;
  }
}
