import { Queue } from 'bullmq';
import IORedis from 'ioredis';
import type { DependencyContainer } from '@/core/dep';
import { env } from '@/core/env';
import { QueueDeps } from './queue.dep';

function createIngestQueue(): Queue {
  const connection = new IORedis(env.REDIS_URL, {
    maxRetriesPerRequest: null,
  });

  return new Queue('ingest', { connection });
}

export function registerQueueDeps(dep: DependencyContainer) {
  dep.addDynamic(QueueDeps.IngestQueue, createIngestQueue);
}
