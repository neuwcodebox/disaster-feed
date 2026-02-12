import { LangfuseSpanProcessor } from '@langfuse/otel';
import { NodeSDK } from '@opentelemetry/sdk-node';
import { env } from '@/core/env';
import { logger } from '@/core/logger';

let nodeSdk: NodeSDK | null = null;

export function initializeLangfuseTracing(): void {
  if (nodeSdk) {
    return;
  }

  if (!env.LANGFUSE_PUBLIC_KEY || !env.LANGFUSE_SECRET_KEY) {
    logger.debug('Langfuse tracing disabled: credentials not configured');
    return;
  }

  const spanProcessor = new LangfuseSpanProcessor({
    publicKey: env.LANGFUSE_PUBLIC_KEY,
    secretKey: env.LANGFUSE_SECRET_KEY,
    baseUrl: env.LANGFUSE_BASE_URL,
    environment: env.NODE_ENV,
  });

  nodeSdk = new NodeSDK({
    spanProcessors: [spanProcessor],
  });
  nodeSdk.start();

  logger.info({ baseUrl: env.LANGFUSE_BASE_URL ?? 'https://cloud.langfuse.com' }, 'Langfuse tracing initialized');
}

export async function shutdownLangfuseTracing(): Promise<void> {
  if (!nodeSdk) {
    return;
  }

  try {
    await nodeSdk.shutdown();
    logger.debug('Langfuse tracing shutdown complete');
  } catch (error) {
    logger.warn({ error }, 'Failed to shutdown Langfuse tracing');
  } finally {
    nodeSdk = null;
  }
}
