import { type Processor, Worker } from 'bullmq';
import IORedis from 'ioredis';
import { env } from '@/core/env';

export function createIngestWorker(processor: Processor): Worker {
  const connection = new IORedis(env.REDIS_URL, {
    maxRetriesPerRequest: null,
  });

  return new Worker('ingest', processor, { connection });
}
