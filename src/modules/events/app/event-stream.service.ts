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

@injectable()
export class EventStreamService {
  private readonly clients = new Set<SSEStreamingApi>();
  private started = false;
  private unsubscribe: (() => Promise<void>) | null = null;

  constructor(
    @inject(EventDeps.EventRepo)
    private readonly eventRepository: IEventRepository,
    @inject(RedisDeps.Subscriber)
    private readonly redisSubscriber: Redis,
  ) {}

  public async start(): Promise<void> {
    if (this.started) {
      return;
    }

    logger.debug('Starting event stream subscriber');
    this.started = true;

    try {
      this.unsubscribe = await subscribeNewEvents(this.redisSubscriber, async (eventId) => {
        await this.handleNewEvent(eventId);
      });
      logger.debug('Subscribed to new event channel');
    } catch (error) {
      this.started = false;
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
    logger.debug('Event stream stopped');
  }

  public addClient(stream: SSEStreamingApi): void {
    this.clients.add(stream);
    logger.debug({ clientCount: this.clients.size }, 'SSE client connected');

    stream.onAbort(() => {
      this.clients.delete(stream);
      logger.debug({ clientCount: this.clients.size }, 'SSE client disconnected');
    });
  }

  public async sendCatchUp(stream: SSEStreamingApi, since?: string): Promise<void> {
    if (!since) {
      return;
    }

    logger.debug({ since }, 'Sending SSE catch-up events');
    const events = await this.eventRepository.listEventsSince({ since });
    for (const event of events) {
      await stream.writeSSE({ data: JSON.stringify(toEventDto(event)) });
    }
    logger.debug({ count: events.length, since }, 'Completed SSE catch-up events');
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
    return sentCount;
  }
}
