import type { Event, NewEvent } from '../entity/event.entity';
import type { EventKinds, EventSources } from '../event.enums';

export type ListEventsParams = {
  limit?: number;
  kind?: EventKinds;
  source?: EventSources;
  since?: string;
};

export type ListEventsAfterIdParams = {
  afterId: string;
  limit?: number;
};

export type LatestFetchedAtBySource = {
  sourceId: EventSources;
  fetchedAt: string;
};

export interface IEventRepository {
  insertEvent(data: NewEvent): Promise<Event>;
  getEventById(id: string): Promise<Event | undefined>;
  listEvents(params: ListEventsParams): Promise<Event[]>;
  listEventsAfterId(params: ListEventsAfterIdParams): Promise<Event[]>;
  listLatestFetchedAtBySources(sourceIds: EventSources[]): Promise<LatestFetchedAtBySource[]>;
}
