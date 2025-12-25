export type EventPayload = Record<string, unknown>;

export type Event = {
  id: string;
  source: string;
  kind: number;
  title: string;
  fetchedAt: string;
  occurredAt: string | null;
  regionText: string | null;
  level: string | null;
  link: string | null;
  payload: EventPayload | null;
};

export type NewEvent = {
  id: string;
  source: string;
  kind: number;
  title: string;
  fetchedAt: string;
  occurredAt?: string | null;
  regionText?: string | null;
  level?: string | null;
  link?: string | null;
  payload?: EventPayload | null;
};
