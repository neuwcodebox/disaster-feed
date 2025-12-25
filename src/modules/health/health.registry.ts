import type { OpenAPIHono } from '@hono/zod-openapi';
import type { DependencyContainer } from '@/core/dep';
import type { IRoute } from '@/view/route.interface';
import { HealthDeps } from './domain/dep/health.dep';
import { HealthRoute } from './view/health.route';

export function registerHealthDeps(dep: DependencyContainer) {
  dep.add(HealthDeps.HealthRoute, HealthRoute);
}

export function registerHealthRoutes(app: OpenAPIHono, dep: DependencyContainer) {
  app.route('/api/health', dep.get<IRoute>(HealthDeps.HealthRoute).getApp());
}
