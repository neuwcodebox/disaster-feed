import { z } from 'zod';
import { ChannelKinds } from '../channel.enums';

const channelKindValues: number[] = [];
for (const value of Object.values(ChannelKinds)) {
  if (typeof value === 'number') {
    channelKindValues.push(value);
  }
}

export const schemaChannelKind = z
  .number()
  .int()
  .refine((value) => channelKindValues.includes(value), { message: 'Invalid channel kind' });
export const schemaChannelLevel = z.number().int().min(1).max(5);
export const schemaChannelMinLevel = schemaChannelLevel;
export const schemaDiscordWebhookUrl = z.url();

export const schemaOutboundChannel = z.object({
  id: z.uuid(),
  kind: schemaChannelKind,
  minLevel: schemaChannelMinLevel,
  target: z.string().min(1),
});

export const schemaOutboundChannelInput = z
  .object({
    kind: schemaChannelKind,
    minLevel: schemaChannelMinLevel,
    target: z.string().min(1),
  })
  .superRefine((value, ctx) => {
    if (value.kind !== ChannelKinds.Discord) {
      return;
    }

    const result = schemaDiscordWebhookUrl.safeParse(value.target);
    if (!result.success) {
      ctx.addIssue({
        code: 'custom',
        message: 'Discord webhook URL is invalid',
        path: ['target'],
      });
    }
  });
