import type { EventSources } from '@/modules/events/domain/event.enums';

export type IngestJobPayload = {
  sourceId: EventSources;
};
