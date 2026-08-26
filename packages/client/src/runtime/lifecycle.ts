export type CanvasLifecycleState =
  | "idle"
  | "starting"
  | "joining"
  | "active"
  | "backgrounded"
  | "reconnecting"
  | "stopping"
  | "stopped"
  | "failed";

export interface CanvasLifecycleSnapshot {
  readonly state: CanvasLifecycleState;
  readonly previousState?: CanvasLifecycleState;
  readonly detail?: string;
}

export type CanvasErrorSource =
  | "lifecycle"
  | "transport"
  | "protocol"
  | "initialization"
  | "simulation"
  | "item-mutation"
  | "assets"
  | "input";

export type CanvasErrorCode =
  | "invalid_lifecycle_state"
  | "start_cancelled"
  | "transport_connection_failed"
  | "transport_reconnect_exhausted"
  | "transport_closed"
  | "server_rejected"
  | "join_initialization_failed"
  | "simulation_failed"
  | "item_mutation_rejected"
  | "asset_preload_failed"
  | "pointer_interaction_failed";

export interface CanvasConsumerErrorOptions {
  code: CanvasErrorCode;
  source: CanvasErrorSource;
  message: string;
  recoverable: boolean;
  cause?: unknown;
  details?: Readonly<Record<string, unknown>>;
}

/** Stable, application-facing error shape for every runtime failure source. */
export class CanvasConsumerError extends Error {
  readonly code: CanvasErrorCode;
  readonly source: CanvasErrorSource;
  readonly recoverable: boolean;
  readonly details?: Readonly<Record<string, unknown>>;
  override readonly cause?: unknown;

  constructor(options: CanvasConsumerErrorOptions) {
    super(options.message);
    this.name = "CanvasConsumerError";
    this.code = options.code;
    this.source = options.source;
    this.recoverable = options.recoverable;
    this.cause = options.cause;
    this.details = options.details
      ? Object.freeze({ ...options.details })
      : undefined;
  }
}

export const lifecycleError = (
  code: CanvasErrorCode,
  message: string,
  options: {
    source?: CanvasErrorSource;
    recoverable?: boolean;
    cause?: unknown;
    details?: Readonly<Record<string, unknown>>;
  } = {},
): CanvasConsumerError => new CanvasConsumerError({
  code,
  message,
  source: options.source ?? "lifecycle",
  recoverable: options.recoverable ?? false,
  cause: options.cause,
  details: options.details,
});
