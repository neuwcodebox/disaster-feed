import { createRoute, OpenAPIHono } from '@hono/zod-openapi';
import { inject } from 'inversify';
import type { IRoute } from '@/view/route.interface';
import { HealthDeps } from '../domain/dep/health.dep';
import { schemaPostHealthReqBody } from '../domain/dto/post-health-req-body.dto';
import { schemaPostHealthResBody } from '../domain/dto/post-health-res-body.dto';
import type { IHealthService } from '../domain/port/health-service.interface';

export class HealthRoute implements IRoute {
  constructor(
    @inject(HealthDeps.HealthService)
    healthService: IHealthService,
  ) {
    this.app.openapi(
      createRoute({
        tags: ['Health'],
        method: 'post',
        path: '/ping',
        summary: 'Health Check',
        description: 'Endpoint to check the health status of the application.',
        request: {
          body: {
            content: {
              'application/json': {
                schema: schemaPostHealthReqBody,
              },
            },
          },
        },
        responses: {
          201: {
            content: {
              'application/json': {
                schema: schemaPostHealthResBody,
              },
            },
            description: 'Health check successful',
          },
        },
      }),
      async (c) => {
        const body = c.req.valid('json');
        const result = await healthService.createHealth(body);
        return c.json(result);
      },
    );
  }

  private readonly app = new OpenAPIHono();

  public getApp(): OpenAPIHono {
    return this.app;
  }
}
