import type { Redis } from 'ioredis';
import { logger } from '@/core/logger';

export const NEW_EVENTS_CHANNEL = 'events:new';

type NewEventMessage = {
  eventId: string;
};
type NewEventHandler = (eventId: string) => Promise<void>;

function parseNewEventMessage(message: string): NewEventMessage | null {
  try {
    const parsed: unknown = JSON.parse(message);
    if (!parsed || typeof parsed !== 'object') {
      return null;
    }

    const eventId = (parsed as { eventId?: unknown }).eventId;
    if (typeof eventId !== 'string') {
      return null;
    }

    return { eventId };
  } catch (error) {
    logger.warn({ error }, 'Failed to parse pubsub message');
    return null;
  }
}

export async function publishNewEvent(redis: Redis, eventId: string): Promise<void> {
  const message: NewEventMessage = { eventId };
  await redis.publish(NEW_EVENTS_CHANNEL, JSON.stringify(message));
}

export async function subscribeNewEvents(redis: Redis, handler: NewEventHandler): Promise<() => Promise<void>> {
  await redis.subscribe(NEW_EVENTS_CHANNEL);

  const onMessage = async (channel: string, message: string) => {
    if (channel !== NEW_EVENTS_CHANNEL) {
      return;
    }

    const parsed = parseNewEventMessage(message);
    if (!parsed) {
      return;
    }

    await handler(parsed.eventId);
  };

  redis.on('message', onMessage);

  return async () => {
    redis.removeListener('message', onMessage);
    await redis.unsubscribe(NEW_EVENTS_CHANNEL);
  };
}
