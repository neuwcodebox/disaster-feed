import { inject, injectable } from 'inversify';
import { EventDeps } from '../domain/dep/event.dep';
import type { GetEventsQueryDto } from '../domain/dto/get-events-query.dto';
import type { EventDto } from '../domain/dto/get-events-res-body.dto';
import type { IEventRepository } from '../domain/port/event-repo.interface';
import type { IEventService } from '../domain/port/event-service.interface';
import { toEventDto } from './event.mapper';

@injectable()
export class EventService implements IEventService {
  constructor(
    @inject(EventDeps.EventRepo)
    private readonly eventRepository: IEventRepository,
  ) {}

  public async listEvents(dto: GetEventsQueryDto): Promise<EventDto[]> {
    const events = await this.eventRepository.listEvents({
      limit: dto.limit,
      kind: dto.kind,
      source: dto.source,
    });

    return events.map((event) => toEventDto(event));
  }
}
