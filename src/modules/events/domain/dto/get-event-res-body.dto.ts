import { z } from 'zod';
import { schemaEvent } from './get-events-res-body.dto';

const schemaEventPayload = z.record(z.string(), z.unknown());

export const schemaEventDetail = schemaEvent.extend({
  payload: schemaEventPayload.nullable(),
});

export type EventDetailDto = z.infer<typeof schemaEventDetail>;
export const schemaGetEventResBody = schemaEventDetail;
