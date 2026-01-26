import { inject, injectable } from 'inversify';
import { EventDeps } from '../domain/dep/event.dep';
import type { GetEventParamsDto } from '../domain/dto/get-event-params.dto';
import type { EventDetailDto } from '../domain/dto/get-event-res-body.dto';
import type { GetEventsQueryDto } from '../domain/dto/get-events-query.dto';
import type { EventDto } from '../domain/dto/get-events-res-body.dto';
import type { IEventRepository } from '../domain/port/event-repo.interface';
import type { IEventService } from '../domain/port/event-service.interface';
import { toEventDetailDto, toEventDto } from './event.mapper';

@injectable()
export class EventService implements IEventService {
  constructor(
    @inject(EventDeps.EventRepo)
    private readonly eventRepository: IEventRepository,
  ) {}

  public async getEventById(dto: GetEventParamsDto): Promise<EventDetailDto | undefined> {
    const event = await this.eventRepository.getEventById(dto.id);
    if (!event) {
      return undefined;
    }

    return toEventDetailDto(event);
  }

  public async listEvents(dto: GetEventsQueryDto): Promise<EventDto[]> {
    const events = await this.eventRepository.listEvents({
      limit: dto.limit,
      kind: dto.kind,
      source: dto.source,
      minLevel: dto.minLevel,
      since: dto.since,
    });

    return events.map((event) => toEventDto(event));
  }
}
