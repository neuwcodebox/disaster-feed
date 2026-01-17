import type { ChannelKinds } from '../channel.enums';

export type OutboundChannel = {
  id: string;
  kind: ChannelKinds;
  minLevel: number;
  target: string;
};

export type NewOutboundChannel = {
  kind: ChannelKinds;
  minLevel: number;
  target: string;
};

export type OutboundDispatchEvent = {
  id: string;
  title: string;
  body: string | null;
  level: number;
  source: number;
  kind: number;
  fetchedAt: string;
  occurredAt: string | null;
  regionText: string | null;
};
