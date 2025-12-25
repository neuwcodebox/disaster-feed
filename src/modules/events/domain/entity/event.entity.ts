import type { EventKind, EventLevel } from '../event.enums';

export type EventPayload = Record<string, unknown>;

export type Event = {
  id: string;
  source: string;
  kind: EventKind;
  title: string;
  body: string | null;
  fetchedAt: string;
  occurredAt: string | null;
  regionText: string | null;
  level: EventLevel;
  link: string | null;
  payload: EventPayload | null;
};

export type NewEvent = {
  id: string;
  source: string;
  kind: EventKind;
  title: string;
  body: string | null;
  fetchedAt: string;
  occurredAt?: string | null;
  regionText?: string | null;
  level: EventLevel;
  link?: string | null;
  payload?: EventPayload | null;
};
