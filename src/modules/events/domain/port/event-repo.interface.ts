import type { Event, NewEvent } from '../entity/event.entity';
import type { EventKinds, EventSources } from '../event.enums';

export type ListEventsParams = {
  limit?: number;
  kind?: EventKinds;
  source?: EventSources;
};

export type ListEventsSinceParams = {
  since: string;
  limit?: number;
};

export interface IEventRepository {
  insertEvent(data: NewEvent): Promise<Event>;
  getEventById(id: string): Promise<Event | undefined>;
  listEvents(params: ListEventsParams): Promise<Event[]>;
  listEventsSince(params: ListEventsSinceParams): Promise<Event[]>;
}
