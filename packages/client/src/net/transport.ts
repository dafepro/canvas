import type { RoomEnvelope } from "@canvas-physics/protocol";

export interface JoinDescriptor {
  canvasId: string;
  userId: string;
  displayName: string;
  /** Base URL of the coordination service, such as http://localhost:8080. */
  serverUrl: string;
}

export type Unsubscribe = () => void;

export type TransportStatus =
  | "idle"
  | "connecting"
  | "open"
  | "reconnecting"
  | "closed"
  | "failed";

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
  close(): void;
}
