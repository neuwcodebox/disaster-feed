import type { GetEventsQueryDto } from '../dto/get-events-query.dto';
import type { EventDto } from '../dto/get-events-res-body.dto';

export interface IEventService {
  listEvents(dto: GetEventsQueryDto): Promise<EventDto[]>;
}
