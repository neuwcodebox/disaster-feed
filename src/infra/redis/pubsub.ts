import type { Redis } from 'ioredis';
import { logger } from '@/core/logger';

export const NEW_EVENTS_CHANNEL = 'events:new';

type NewEventMessage = {
  eventId: string;
};

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

export async function subscribeNewEvents(redis: Redis, handler: (eventId: string) => Promise<void>): Promise<void> {
  await redis.subscribe(NEW_EVENTS_CHANNEL);

  redis.on('message', async (channel, message) => {
    if (channel !== NEW_EVENTS_CHANNEL) {
      return;
    }

    const parsed = parseNewEventMessage(message);
    if (!parsed) {
      return;
    }

    await handler(parsed.eventId);
  });
}
