import { type Processor, Worker } from 'bullmq';
import IORedis from 'ioredis';
import { env } from '@/core/env';
import { OUTBOUND_DISPATCH_QUEUE_NAME } from './outbound-dispatch.constants';

export function createIngestWorker(processor: Processor): Worker {
  const connection = new IORedis(env.REDIS_URL, {
    maxRetriesPerRequest: null,
  });

  return new Worker('ingest', processor, { connection });
}

export function createOutboundDispatchWorker(processor: Processor): Worker {
  const connection = new IORedis(env.REDIS_URL, {
    maxRetriesPerRequest: null,
  });

  return new Worker(OUTBOUND_DISPATCH_QUEUE_NAME, processor, { connection });
}
