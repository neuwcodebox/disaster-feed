import IORedis, { type Redis } from 'ioredis';
import type { DependencyContainer } from '@/core/dep';
import { env } from '@/core/env';
import { RedisDeps } from './redis.dep';

function createRedisClient(): Redis {
  return new IORedis(env.REDIS_URL);
}

function createRedisSubscriber(): Redis {
  return new IORedis(env.REDIS_URL);
}

export function registerRedisDeps(dep: DependencyContainer) {
  dep.addDynamic(RedisDeps.Client, createRedisClient);
  dep.addDynamic(RedisDeps.Subscriber, createRedisSubscriber);
}
