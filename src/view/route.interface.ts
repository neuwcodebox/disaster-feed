import type { OpenAPIHono } from '@hono/zod-openapi';

export interface IRoute {
  getApp(): OpenAPIHono;
}
