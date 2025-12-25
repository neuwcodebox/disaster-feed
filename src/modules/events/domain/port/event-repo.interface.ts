import type { Event, NewEvent } from '../entity/event.entity';
import type { EventKind } from '../event.enums';

export type ListEventsParams = {
  limit?: number;
  kind?: EventKind;
  source?: string;
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
