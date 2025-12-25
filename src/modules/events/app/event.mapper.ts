import type { EventDto } from '../domain/dto/get-events-res-body.dto';
import type { Event } from '../domain/entity/event.entity';

export function toEventDto(event: Event): EventDto {
  return {
    id: event.id,
    source: event.source,
    kind: event.kind,
    title: event.title,
    fetchedAt: event.fetchedAt,
    occurredAt: event.occurredAt,
    regionText: event.regionText,
    level: event.level ?? null,
    link: event.link ?? null,
    payload: event.payload ?? null,
  };
}
