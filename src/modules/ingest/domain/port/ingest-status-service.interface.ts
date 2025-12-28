import type { GetIngestSourcesResBodyDto } from '../dto/get-ingest-sources-res-body.dto';

export interface IIngestStatusService {
  listSourceStatuses(): Promise<GetIngestSourcesResBodyDto>;
}
