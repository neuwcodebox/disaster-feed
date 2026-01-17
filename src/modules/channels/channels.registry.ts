import type { OpenAPIHono } from '@hono/zod-openapi';
import type { DependencyContainer } from '@/core/dep';
import type { IRoute } from '@/view/route.interface';
import { OutboundChannelService } from './app/channel.service';
import { OutboundChannelDispatchService } from './app/channel-dispatch.service';
import { OutboundDispatchQueueService } from './app/outbound-dispatch-queue.service';
import { OutboundDispatchWorkerService } from './app/outbound-dispatch-worker.service';
import { ChannelDeps } from './domain/dep/channel.dep';
import { OutboundChannelRepository } from './infra/channel.repo';
import { ChannelRoute } from './view/channel.route';

export function registerChannelDeps(dep: DependencyContainer) {
  dep.add(ChannelDeps.ChannelRepo, OutboundChannelRepository);
  dep.add(ChannelDeps.ChannelService, OutboundChannelService);
  dep.add(ChannelDeps.ChannelDispatchService, OutboundChannelDispatchService);
  dep.add(ChannelDeps.ChannelDispatchQueueService, OutboundDispatchQueueService);
  dep.add(ChannelDeps.ChannelDispatchWorkerService, OutboundDispatchWorkerService);
  dep.add(ChannelDeps.ChannelRoute, ChannelRoute);
}

export function registerChannelRoutes(app: OpenAPIHono, dep: DependencyContainer) {
  app.route('/api/admin/channels', dep.get<IRoute>(ChannelDeps.ChannelRoute).getApp());
}

export function startOutboundDispatch(dep: DependencyContainer) {
  dep.get<OutboundDispatchWorkerService>(ChannelDeps.ChannelDispatchWorkerService).start();
}

export async function stopOutboundDispatch(dep: DependencyContainer): Promise<void> {
  await dep.get<OutboundDispatchWorkerService>(ChannelDeps.ChannelDispatchWorkerService).stop();
  await dep.get<OutboundDispatchQueueService>(ChannelDeps.ChannelDispatchQueueService).stop();
}
