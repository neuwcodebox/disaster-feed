import type { EventDetailDto } from '../domain/dto/get-event-res-body.dto';
import type { EventDto } from '../domain/dto/get-events-res-body.dto';
import type { Event } from '../domain/entity/event.entity';

export function toEventDto(event: Event): EventDto {
  return {
    id: event.id,
    source: event.source,
    kind: event.kind,
    title: event.title,
    body: event.body ?? null,
    fetchedAt: event.fetchedAt,
    occurredAt: event.occurredAt,
    regionText: event.regionText,
    geo: event.geo ?? null,
    regionCodes: event.regionCodes ?? null,
    level: event.level,
  };
}

export function toEventDetailDto(event: Event): EventDetailDto {
  return {
    ...toEventDto(event),
    payload: event.payload ?? null,
  };
}
