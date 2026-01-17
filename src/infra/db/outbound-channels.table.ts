import type { Insertable, Selectable, Updateable } from 'kysely';

export interface OutboundChannelsTable {
  id: string;
  kind: number;
  min_level: number;
  target: string;
}

export type OutboundChannelRow = Selectable<OutboundChannelsTable>;
export type NewOutboundChannelRow = Insertable<OutboundChannelsTable>;
export type OutboundChannelUpdateRow = Updateable<OutboundChannelsTable>;
