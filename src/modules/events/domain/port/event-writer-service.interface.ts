import type { Event, NewEvent } from '../entity/event.entity';

export interface IEventWriterService {
  appendEvent(data: NewEvent): Promise<Event>;
}
