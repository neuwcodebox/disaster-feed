import type { EventKinds, EventLevels, EventSources } from '../event.enums';

export type EventPayload = Record<string, unknown>;

export type Event = {
  id: string;
  source: EventSources;
  kind: EventKinds;
  title: string;
  body: string | null;
  fetchedAt: string;
  occurredAt: string | null;
  regionText: string | null;
  level: EventLevels;
  payload: EventPayload | null;
};

export type NewEvent = {
  id: string;
  source: EventSources;
  kind: EventKinds;
  title: string;
  body: string | null;
  fetchedAt: string;
  occurredAt?: string | null;
  regionText?: string | null;
  level: EventLevels;
  payload?: EventPayload | null;
};
