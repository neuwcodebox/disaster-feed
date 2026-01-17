import { Queue } from 'bullmq';
import IORedis from 'ioredis';
import type { DependencyContainer } from '@/core/dep';
import { env } from '@/core/env';
import { OUTBOUND_DISPATCH_QUEUE_NAME } from './outbound-dispatch.constants';
import { QueueDeps } from './queue.dep';

export function registerQueueDeps(dep: DependencyContainer) {
  dep.addDynamic(QueueDeps.IngestQueue, createIngestQueue);
  dep.addDynamic(QueueDeps.OutboundDispatchQueue, createOutboundDispatchQueue);
}

function createIngestQueue(): Queue {
  const connection = new IORedis(env.REDIS_URL, {
    maxRetriesPerRequest: null,
  });

  return new Queue('ingest', { connection });
}

function createOutboundDispatchQueue(): Queue {
  const connection = new IORedis(env.REDIS_URL, {
    maxRetriesPerRequest: null,
  });

  return new Queue(OUTBOUND_DISPATCH_QUEUE_NAME, { connection });
}
