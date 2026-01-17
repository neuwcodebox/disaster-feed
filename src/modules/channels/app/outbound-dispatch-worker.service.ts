import type { Job, Worker } from 'bullmq';
import { inject, injectable } from 'inversify';
import { logger } from '@/core/logger';
import { createOutboundDispatchWorker } from '@/infra/queue/worker';
import { EventDeps } from '@/modules/events/domain/dep/event.dep';
import type { Event } from '@/modules/events/domain/entity/event.entity';
import type { IEventRepository } from '@/modules/events/domain/port/event-repo.interface';
import { ChannelDeps } from '../domain/dep/channel.dep';
import type { OutboundDispatchJobPayload } from '../domain/dto/outbound-dispatch-job.dto';
import type { OutboundDispatchEvent } from '../domain/entity/outbound-channel.entity';
import type { IOutboundChannelDispatcher } from '../domain/port/channel-dispatcher.interface';

@injectable()
export class OutboundDispatchWorkerService {
  private worker: Worker<OutboundDispatchJobPayload> | null = null;

  constructor(
    @inject(EventDeps.EventRepo)
    private readonly eventRepository: IEventRepository,
    @inject(ChannelDeps.ChannelDispatchService)
    private readonly channelDispatcher: IOutboundChannelDispatcher,
  ) {}

  public start(): void {
    if (this.worker) {
      return;
    }

    this.worker = createOutboundDispatchWorker(this.processJob.bind(this));
    logger.debug('Outbound dispatch worker started');
    this.worker.on('failed', (job, error) => {
      logger.error({ error, jobId: job?.id }, 'Outbound dispatch job failed');
    });
  }

  public async stop(): Promise<void> {
    if (!this.worker) {
      return;
    }

    try {
      await this.worker.close();
      logger.debug('Outbound dispatch worker stopped');
    } catch (error) {
      logger.warn({ error }, 'Failed to stop outbound dispatch worker');
    } finally {
      this.worker = null;
    }
  }

  private async processJob(job: Job<OutboundDispatchJobPayload>): Promise<void> {
    await handleOutboundDispatchJob(this.eventRepository, this.channelDispatcher, job.data);
  }
}

export async function handleOutboundDispatchJob(
  eventRepository: IEventRepository,
  channelDispatcher: IOutboundChannelDispatcher,
  payload: OutboundDispatchJobPayload,
): Promise<void> {
  const event = await eventRepository.getEventById(payload.eventId);
  if (!event) {
    logger.warn({ eventId: payload.eventId }, 'Outbound dispatch event not found');
    return;
  }

  await channelDispatcher.dispatchEvent(toDispatchEvent(event));
}

function toDispatchEvent(event: Event): OutboundDispatchEvent {
  return {
    id: event.id,
    title: event.title,
    body: event.body ?? null,
    level: event.level,
    source: event.source,
    kind: event.kind,
    fetchedAt: event.fetchedAt,
    occurredAt: event.occurredAt ?? null,
    regionText: event.regionText ?? null,
  };
}
