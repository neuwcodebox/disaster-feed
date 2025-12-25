import type { DependencyContainer } from '@/core/dep';
import { logger } from '@/core/logger';
import { IngestSchedulerService } from './app/ingest-scheduler.service';
import { IngestWorkerService } from './app/ingest-worker.service';
import { SourceRegistry } from './app/source.registry';
import { IngestDeps } from './domain/dep/ingest.dep';

export function registerIngestDeps(dep: DependencyContainer) {
  dep.add(IngestDeps.SourceRegistry, SourceRegistry);
  dep.add(IngestDeps.IngestSchedulerService, IngestSchedulerService);
  dep.add(IngestDeps.IngestWorkerService, IngestWorkerService);
}

export async function startIngest(dep: DependencyContainer): Promise<void> {
  const scheduler = dep.get<IngestSchedulerService>(IngestDeps.IngestSchedulerService);
  const worker = dep.get<IngestWorkerService>(IngestDeps.IngestWorkerService);

  try {
    await scheduler.scheduleRepeatableJobs();
  } catch (error) {
    logger.error({ error }, 'Failed to schedule ingest jobs');
  }

  worker.start();
}
