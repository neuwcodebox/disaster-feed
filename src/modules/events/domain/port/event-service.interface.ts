import type { GetEventParamsDto } from '../dto/get-event-params.dto';
import type { EventDetailDto } from '../dto/get-event-res-body.dto';
import type { GetEventsQueryDto } from '../dto/get-events-query.dto';
import type { EventDto } from '../dto/get-events-res-body.dto';

export interface IEventService {
  getEventById(dto: GetEventParamsDto): Promise<EventDetailDto | undefined>;
  listEvents(dto: GetEventsQueryDto): Promise<EventDto[]>;
}
