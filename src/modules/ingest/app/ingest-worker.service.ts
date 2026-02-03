import type { Job, Worker } from 'bullmq';
import { inject, injectable } from 'inversify';
import { logger } from '@/core/logger';
import { createUuidV7 } from '@/core/uuid';
import { createIngestWorker } from '@/infra/queue/worker';
import { EventDeps } from '@/modules/events/domain/dep/event.dep';
import type { EventSources } from '@/modules/events/domain/event.enums';
import type { IEventRepository } from '@/modules/events/domain/port/event-repo.interface';
import type { IEventWriterService } from '@/modules/events/domain/port/event-writer-service.interface';
import { IngestDeps } from '../domain/dep/ingest.dep';
import type { IngestJobPayload } from '../domain/dto/ingest-job.dto';
import { NonRetryError } from '../domain/ingest.errors';
import type { IIngestCheckpointRepository } from '../domain/port/ingest-checkpoint-repo.interface';
import type { SourceEvent } from '../domain/port/source.interface';
import type { SourceRegistry } from './source.registry';

const DAY_MS = 24 * 60 * 60 * 1000;
const EVENT_RETENTION_DAYS = 30;
const EVENT_PRUNE_INTERVAL_MS = 6 * 60 * 60 * 1000;
const EVENT_PRUNE_BATCH_SIZE = 2000;
const EVENT_PRUNE_MAX_BATCHES = 3;

@injectable()
export class IngestWorkerService {
  private worker: Worker<IngestJobPayload> | null = null;
  private readonly runningSourceIds = new Set<EventSources>();
  private lastCleanupAtMs = 0;
  private cleanupRunning = false;

  constructor(
    @inject(IngestDeps.SourceRegistry)
    private readonly sourceRegistry: SourceRegistry,
    @inject(EventDeps.EventWriterService)
    private readonly eventWriter: IEventWriterService,
    @inject(IngestDeps.IngestCheckpointRepository)
    private readonly ingestCheckpointRepository: IIngestCheckpointRepository,
    @inject(EventDeps.EventRepo)
    private readonly eventRepository: IEventRepository,
  ) {}

  public start(): void {
    if (this.worker) {
      return;
    }

    this.worker = createIngestWorker(this.processJob.bind(this));
    logger.debug('Ingest worker started');
    this.worker.on('failed', (job, error) => {
      logger.error({ error, jobId: job?.id }, 'Ingest job failed');
    });
  }

  public async stop(): Promise<void> {
    if (!this.worker) {
      return;
    }

    try {
      await this.worker.close();
      logger.debug('Ingest worker stopped');
    } catch (error) {
      logger.warn({ error }, 'Failed to stop ingest worker');
    } finally {
      this.worker = null;
    }
  }

  private async processJob(job: Job<IngestJobPayload>): Promise<void> {
    const sourceId = job.data.sourceId;
    const source = this.sourceRegistry.get(sourceId);
    if (!source) {
      logger.warn({ sourceId }, 'Source not found for ingest job');
      return;
    }

    if (this.runningSourceIds.has(sourceId)) {
      logger.warn({ sourceId, jobId: job.id }, 'Skipping ingest job due to running source');
      return;
    }

    this.runningSourceIds.add(sourceId);

    try {
      const checkpoint = await this.ingestCheckpointRepository.getCheckpoint(sourceId);
      const checkpointState = checkpoint?.state ?? null;

      logger.debug({ sourceId, jobId: job.id }, 'Running ingest job');
      const fetchedAt = new Date().toISOString();
      const { events, nextState } = await source.run(checkpointState);

      await this.ingestCheckpointRepository.upsertCheckpoint(sourceId, nextState);

      for (const event of events) {
        await this.insertEvent(source.sourceId, fetchedAt, event);
      }

      logger.debug({ sourceId, jobId: job.id, eventCount: events.length }, 'Completed ingest job');
    } catch (error) {
      if (error instanceof NonRetryError) {
        logger.warn({ error, sourceId, jobId: job.id }, 'Skipping non-retryable ingest error');
      } else {
        throw error;
      }
    } finally {
      this.runningSourceIds.delete(sourceId);
      await this.maybeCleanupOldEvents();
    }
  }

  private async insertEvent(sourceId: EventSources, fetchedAt: string, event: SourceEvent): Promise<boolean> {
    try {
      await this.eventWriter.appendEvent({
        id: createUuidV7(),
        source: sourceId,
        kind: event.kind,
        title: event.title,
        body: event.body ?? null,
        fetchedAt,
        occurredAt: event.occurredAt ?? null,
        regionText: event.regionText ?? null,
        geo: event.geo ?? null,
        regionCodes: event.regionCodes ?? null,
        level: event.level,
        payload: event.payload ?? null,
      });
      return true;
    } catch (error) {
      logger.error({ error, sourceId }, 'Failed to append event');
      return false;
    }
  }

  private async maybeCleanupOldEvents(): Promise<void> {
    if (this.cleanupRunning) {
      return;
    }

    const nowMs = Date.now();
    if (this.lastCleanupAtMs > 0 && nowMs - this.lastCleanupAtMs < EVENT_PRUNE_INTERVAL_MS) {
      return;
    }

    this.cleanupRunning = true;

    try {
      const cutoff = new Date(nowMs - EVENT_RETENTION_DAYS * DAY_MS);
      let deletedTotal = 0;

      for (let batch = 0; batch < EVENT_PRUNE_MAX_BATCHES; batch += 1) {
        const deleted = await this.eventRepository.deleteEventsBefore(cutoff, EVENT_PRUNE_BATCH_SIZE);
        deletedTotal += deleted;

        if (deleted < EVENT_PRUNE_BATCH_SIZE) {
          break;
        }
      }

      this.lastCleanupAtMs = nowMs;

      if (deletedTotal > 0) {
        logger.info({ deletedTotal, cutoff: cutoff.toISOString() }, 'Pruned old events');
      } else {
        logger.debug({ cutoff: cutoff.toISOString() }, 'No old events to prune');
      }
    } catch (error) {
      logger.warn({ error }, 'Failed to prune old events');
    } finally {
      this.cleanupRunning = false;
    }
  }
}
