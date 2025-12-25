import type { Event, NewEvent } from '../entity/event.entity';

export type ListEventsParams = {
  limit?: number;
  kind?: number;
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
