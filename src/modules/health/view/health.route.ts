import { createRoute, OpenAPIHono } from '@hono/zod-openapi';
import type { IRoute } from '@/view/route.interface';
import { schemaGetPingResBody } from '../domain/dto/get-ping-res-body.dto';

export class HealthRoute implements IRoute {
  constructor() {
    this.app.openapi(
      createRoute({
        tags: ['Health'],
        method: 'get',
        path: '/ping',
        summary: 'Ping',
        description: 'Endpoint to check the health status of the application.',
        responses: {
          200: {
            content: {
              'application/json': {
                schema: schemaGetPingResBody,
              },
            },
            description: 'Ping successful',
          },
        },
      }),
      (c) => c.json({ ok: true, timestamp: Date.now() }),
    );
  }

  private readonly app = new OpenAPIHono();

  public getApp(): OpenAPIHono {
    return this.app;
  }
}
