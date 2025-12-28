import { z } from 'zod';

export const schemaIngestSourceStatus = z.object({
  sourceId: z.number().int(),
  sourceKey: z.string(),
  status: z.enum(['ok', 'stale', 'never', 'disabled']),
  pollIntervalSec: z.number().int().positive(),
  lastSuccessAt: z.string().nullable(),
  latestEventAt: z.string().nullable(),
  lagSec: z.number().int().nonnegative().nullable(),
  staleAfterSec: z.number().int().nonnegative(),
});

export type IngestSourceStatusDto = z.infer<typeof schemaIngestSourceStatus>;

export const schemaGetIngestSourcesResBody = z.object({
  generatedAt: z.string(),
  sources: z.array(schemaIngestSourceStatus),
});

export type GetIngestSourcesResBodyDto = z.infer<typeof schemaGetIngestSourcesResBody>;
