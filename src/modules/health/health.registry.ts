import type { OpenAPIHono } from '@hono/zod-openapi';
import type { DependencyContainer } from '@/core/dep';
import type { IRoute } from '@/view/route.interface';
import { HealthService } from './app/health.service';
import { HealthDeps } from './domain/dep/health.dep';
import { HealthRepository } from './infra/health.repo';
import { HealthRoute } from './view/health.route';

export function registerHealthDeps(dep: DependencyContainer) {
  dep.add(HealthDeps.HealthRepo, HealthRepository);
  dep.add(HealthDeps.HealthService, HealthService);
  dep.add(HealthDeps.HealthRoute, HealthRoute);
}

export function registerHealthRoutes(app: OpenAPIHono, dep: DependencyContainer) {
  app.route('/api/health', dep.get<IRoute>(HealthDeps.HealthRoute).getApp());
}
