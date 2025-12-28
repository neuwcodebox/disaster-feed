import { inject, injectable } from 'inversify';
import { EventDeps } from '@/modules/events/domain/dep/event.dep';
import { EventSources } from '@/modules/events/domain/event.enums';
import type { IEventRepository } from '@/modules/events/domain/port/event-repo.interface';
import { IngestDeps } from '../domain/dep/ingest.dep';
import type { GetIngestSourcesResBodyDto, IngestSourceStatusDto } from '../domain/dto/get-ingest-sources-res-body.dto';
import type { IIngestCheckpointRepository, IngestCheckpoint } from '../domain/port/ingest-checkpoint-repo.interface';
import type { IIngestStatusService } from '../domain/port/ingest-status-service.interface';
import type { SourceRegistry } from './source.registry';

@injectable()
export class IngestStatusService implements IIngestStatusService {
  constructor(
    @inject(IngestDeps.SourceRegistry)
    private readonly sourceRegistry: SourceRegistry,
    @inject(IngestDeps.IngestCheckpointRepository)
    private readonly ingestCheckpointRepository: IIngestCheckpointRepository,
    @inject(EventDeps.EventRepo)
    private readonly eventRepository: IEventRepository,
  ) {}

  public async listSourceStatuses(): Promise<GetIngestSourcesResBodyDto> {
    const sources = this.sourceRegistry.list();
    const sourceIds: EventSources[] = [];

    for (const source of sources) {
      sourceIds.push(source.sourceId);
    }

    const [checkpoints, latestEvents] = await Promise.all([
      this.ingestCheckpointRepository.listCheckpoints(),
      this.eventRepository.listLatestFetchedAtBySources(sourceIds),
    ]);

    const checkpointMap = new Map<EventSources, IngestCheckpoint>();
    for (const checkpoint of checkpoints) {
      checkpointMap.set(checkpoint.sourceId, checkpoint);
    }

    const latestEventMap = new Map<EventSources, string>();
    for (const latestEvent of latestEvents) {
      latestEventMap.set(latestEvent.sourceId, latestEvent.fetchedAt);
    }

    const nowMs = Date.now();
    const statuses: IngestSourceStatusDto[] = [];

    for (const source of sources) {
      const checkpoint = checkpointMap.get(source.sourceId);
      const lastSuccessAt = checkpoint?.updatedAt ?? null;
      const latestEventAt = latestEventMap.get(source.sourceId) ?? null;
      const pollIntervalSec = source.pollIntervalSec;
      const staleAfterSec = pollIntervalSec * 2;

      const lastSuccessAtMs = lastSuccessAt ? Date.parse(lastSuccessAt) : Number.NaN;
      const lagSec = Number.isFinite(lastSuccessAtMs)
        ? Math.max(0, Math.floor((nowMs - lastSuccessAtMs) / 1000))
        : null;

      let status: IngestSourceStatusDto['status'];

      if (lagSec === null) {
        status = 'never';
      } else if (lagSec > staleAfterSec) {
        // 마지막 성공 시각이 2회 주기 이상 지연되면 stale로 판단
        status = 'stale';
      } else {
        status = 'ok';
      }

      statuses.push({
        sourceId: source.sourceId,
        sourceKey: EventSources[source.sourceId] ?? String(source.sourceId),
        status,
        pollIntervalSec,
        lastSuccessAt,
        latestEventAt,
        lagSec,
        staleAfterSec,
      });
    }

    return {
      generatedAt: new Date(nowMs).toISOString(),
      sources: statuses,
    };
  }
}
