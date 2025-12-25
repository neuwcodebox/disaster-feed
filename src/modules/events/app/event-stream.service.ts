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

    this.started = true;

    try {
      await subscribeNewEvents(this.redisSubscriber, async (eventId) => {
        await this.handleNewEvent(eventId);
      });
    } catch (error) {
      this.started = false;
      logger.error({ error }, 'Failed to start event stream service');
    }
  }

  public addClient(stream: SSEStreamingApi): void {
    this.clients.add(stream);

    stream.onAbort(() => {
      this.clients.delete(stream);
    });
  }

  public async sendCatchUp(stream: SSEStreamingApi, since?: string): Promise<void> {
    if (!since) {
      return;
    }

    const events = await this.eventRepository.listEventsSince({ since });
    for (const event of events) {
      await stream.writeSSE({ data: JSON.stringify(toEventDto(event)) });
    }
  }

  private async handleNewEvent(eventId: string): Promise<void> {
    const event = await this.eventRepository.getEventById(eventId);
    if (!event) {
      logger.warn({ eventId }, 'Event not found for pubsub message');
      return;
    }

    await this.broadcast(event);
  }

  private async broadcast(event: Event): Promise<void> {
    const payload = JSON.stringify(toEventDto(event));

    for (const client of this.clients) {
      if (client.aborted || client.closed) {
        this.clients.delete(client);
        continue;
      }

      try {
        await client.writeSSE({ data: payload, id: event.id });
      } catch (error) {
        this.clients.delete(client);
        logger.warn({ error }, 'Failed to broadcast SSE');
      }
    }
  }
}
