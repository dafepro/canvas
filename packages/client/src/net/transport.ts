import type { RoomEnvelope } from "@canvas-physics/protocol";

export interface JoinDescriptor {
  /** Product-owned room instance id, independent from its canvas template. */
  roomId: string;
  /** Base URL of the coordination service, such as http://localhost:8080. */
  serverUrl: string;
}

export type Unsubscribe = () => void;

export type TransportStatus =
  | "idle"
  | "credentials"
  | "connecting"
  | "open"
  | "reconnecting"
  | "closed"
  | "failed";

/**
 * Spec 22.1. Realtime bytes and messages in each direction. A transport counts
 * the encoded size, so the number matches what the socket carried.
 */
export interface TransportTraffic {
  inboundBytes: number;
  outboundBytes: number;
  inboundMessages: number;
  outboundMessages: number;
  /** Realtime packets the transport dropped because the send buffer was full. */
  droppedOutbound: number;
}

export const emptyTraffic = (): TransportTraffic => ({
  inboundBytes: 0,
  outboundBytes: 0,
  inboundMessages: 0,
  outboundMessages: 0,
  droppedOutbound: 0,
});

/**
 * Spec 12.2. Gameplay code speaks only to this interface, so a later WebRTC
 * transport needs no change to the runtime or the behaviors.
 */
export interface RoomTransport {
  connect(join: JoinDescriptor): Promise<void>;
  /** Reliable ordered delivery: coordination and durable mutations. */
  sendReliable(message: RoomEnvelope): void;
  /** Newest matters most: input and state deltas. */
  sendRealtime(message: RoomEnvelope): void;
  onMessage(handler: (message: RoomEnvelope) => void): Unsubscribe;
  onStatus(handler: (status: TransportStatus, detail?: string) => void): Unsubscribe;
  readonly status: TransportStatus;
  /** Spec 22.1. Cumulative counters since the transport was created. */
  readonly traffic: TransportTraffic;
  close(): void;
}
