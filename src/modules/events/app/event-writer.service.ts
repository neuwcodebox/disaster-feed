import { inject, injectable } from 'inversify';
import type { Redis } from 'ioredis';
import { logger } from '@/core/logger';
import { publishNewEvent } from '@/infra/redis/pubsub';
import { RedisDeps } from '@/infra/redis/redis.dep';
import { EventDeps } from '../domain/dep/event.dep';
import type { Event, NewEvent } from '../domain/entity/event.entity';
import type { IEventRepository } from '../domain/port/event-repo.interface';
import type { IEventWriterService } from '../domain/port/event-writer-service.interface';

@injectable()
export class EventWriterService implements IEventWriterService {
  constructor(
    @inject(EventDeps.EventRepo)
    private readonly eventRepository: IEventRepository,
    @inject(RedisDeps.Client)
    private readonly redisClient: Redis,
  ) {}

  public async appendEvent(data: NewEvent): Promise<Event> {
    const event = await this.eventRepository.insertEvent(data);
    logger.debug({ eventId: event.id, source: event.source, kind: event.kind }, 'Event persisted');

    try {
      await publishNewEvent(this.redisClient, event.id);
      logger.debug({ eventId: event.id }, 'Published new event');
    } catch (error) {
      logger.warn({ error, eventId: event.id }, 'Failed to publish new event');
    }

    return event;
  }
}
