export interface IOutboundDispatchQueue {
  enqueueEvent(eventId: string): Promise<void>;
  stop(): Promise<void>;
}
