import { createRoute, OpenAPIHono } from '@hono/zod-openapi';
import { inject } from 'inversify';
import type { IRoute } from '@/view/route.interface';
import { IngestDeps } from '../domain/dep/ingest.dep';
import { schemaGetIngestSourcesResBody } from '../domain/dto/get-ingest-sources-res-body.dto';
import type { IIngestStatusService } from '../domain/port/ingest-status-service.interface';

export class IngestRoute implements IRoute {
  constructor(
    @inject(IngestDeps.IngestStatusService)
    ingestStatusService: IIngestStatusService,
  ) {
    this.app.openapi(
      createRoute({
        tags: ['Ingest'],
        method: 'get',
        path: '/sources',
        summary: 'List ingest source statuses',
        responses: {
          200: {
            content: {
              'application/json': {
                schema: schemaGetIngestSourcesResBody,
              },
            },
            description: 'Ingest source statuses',
          },
        },
      }),
      async (c) => {
        const result = await ingestStatusService.listSourceStatuses();
        return c.json(result);
      },
    );
  }

  private readonly app = new OpenAPIHono();

  public getApp(): OpenAPIHono {
    return this.app;
  }
}
