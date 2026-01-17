import type { OutboundDispatchEvent } from '../entity/outbound-channel.entity';

export interface IOutboundChannelDispatcher {
  dispatchEvent(event: OutboundDispatchEvent): Promise<void>;
}
