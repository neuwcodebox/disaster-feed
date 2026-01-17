import type { Queue } from 'bullmq';
import { inject, injectable } from 'inversify';
import { logger } from '@/core/logger';
import { OUTBOUND_DISPATCH_JOB_NAME } from '@/infra/queue/outbound-dispatch.constants';
import { QueueDeps } from '@/infra/queue/queue.dep';
import type { OutboundDispatchJobPayload } from '../domain/dto/outbound-dispatch-job.dto';
import type { IOutboundDispatchQueue } from '../domain/port/outbound-dispatch-queue.interface';

@injectable()
export class OutboundDispatchQueueService implements IOutboundDispatchQueue {
  constructor(
    @inject(QueueDeps.OutboundDispatchQueue)
    private readonly queue: Queue<OutboundDispatchJobPayload>,
  ) {}

  public async enqueueEvent(eventId: string): Promise<void> {
    await this.queue.add(
      OUTBOUND_DISPATCH_JOB_NAME,
      { eventId },
      {
        jobId: eventId,
        attempts: 3,
        backoff: { type: 'exponential', delay: 3000 },
        removeOnComplete: true,
        removeOnFail: true,
      },
    );
    logger.debug({ eventId }, 'Outbound dispatch job enqueued');
  }

  public async stop(): Promise<void> {
    try {
      await this.queue.close();
      logger.debug('Outbound dispatch queue closed');
    } catch (error) {
      logger.warn({ error }, 'Failed to close outbound dispatch queue');
    }
  }
}
