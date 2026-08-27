import type { CanvasDefinition, CanvasSnapshot } from "@canvas-physics/core";
import type { TransportStatus } from "../../net/transport.js";
import {
  CanvasConsumerError,
  lifecycleError,
  type CanvasLifecycleSnapshot,
  type CanvasLifecycleState,
} from "../lifecycle.js";
import {
  systemSessionClock,
  type SessionClock,
  type SessionInterval,
} from "./session-clock.js";
import {
  ObserverSet,
  type Observer,
  type ObserverErrorHandler,
  type SubscriptionOptions,
} from "../observers.js";

export interface ConnectionJoin {
  readonly generation: number;
  readonly canvas: CanvasDefinition;
  readonly snapshot: CanvasSnapshot;
  readonly wasSleeping: boolean;
}

export type ConnectionEffect =
  | {
      readonly type: "connectionReset";
      readonly generation: number;
      readonly reason: "open" | "reconnecting";
    }
  | { readonly type: "failed"; readonly error: CanvasConsumerError };

export interface ConnectionSessionOptions {
  readonly clock?: SessionClock;
  readonly validateJoin?: (canvas: CanvasDefinition, snapshot: CanvasSnapshot) => void;
  readonly initializeConsumer?: (
    canvas: CanvasDefinition,
    snapshot: CanvasSnapshot,
    wasSleeping: boolean,
  ) => void | Promise<void>;
  readonly installJoin: (join: ConnectionJoin) => void;
  readonly emit: (effect: ConnectionEffect) => void;
  readonly onObserverError?: ObserverErrorHandler;
}

/** Owns single-use connection lifecycle, JOIN generations, and public readiness. */
export class ConnectionSession {
  private generationValue = 0;
  private lifecycleValue: CanvasLifecycleState = "idle";
  private snapshotValue: CanvasLifecycleSnapshot = Object.freeze({ state: "idle" });
  private readonly observers: ObserverSet<CanvasLifecycleSnapshot>;
  private readonly readyWaiters = new Set<{
    resolve: () => void;
    reject: (error: CanvasConsumerError) => void;
  }>();
  private pendingJoin?: ConnectionJoin;
  private consumerInitialization?: Promise<void>;
  private consumerInitialized = false;
  private initializedCanvas?: Readonly<{ id: string; version: number }>;
  private startPromise?: Promise<void>;
  private terminalErrorValue?: CanvasConsumerError;
  private pageVisibleValue = true;
  private runningValue = false;
  private resourcesClosed = false;
  private readonly clock: SessionClock;
  private schedules: SessionInterval[] = [];

  constructor(private readonly options: ConnectionSessionOptions) {
    this.clock = options.clock ?? systemSessionClock;
    this.observers = new ObserverSet(options.onObserverError);
  }

  get generation(): number {
    return this.generationValue;
  }

  get lifecycleState(): CanvasLifecycleState {
    return this.lifecycleValue;
  }

  get lifecycleSnapshot(): CanvasLifecycleSnapshot {
    return this.snapshotValue;
  }

  get terminalError(): CanvasConsumerError | undefined {
    return this.terminalErrorValue;
  }

  get pageVisible(): boolean {
    return this.pageVisibleValue;
  }

  get running(): boolean {
    return this.runningValue;
  }

  get isTerminalOrStopping(): boolean {
    return this.lifecycleValue === "stopping" || this.lifecycleValue === "stopped" ||
      this.lifecycleValue === "failed";
  }

  claimResourceClose(): boolean {
    if (this.resourcesClosed) return false;
    this.resourcesClosed = true;
    return true;
  }

  schedule(callback: () => void, everyMs: number): void {
    if (this.isTerminalOrStopping) return;
    this.schedules.push(this.clock.setInterval(callback, everyMs));
  }

  subscribe(
    observer: Observer<CanvasLifecycleSnapshot>,
    options?: SubscriptionOptions,
  ): () => void {
    return this.observers.subscribe(observer, options, () => this.snapshotValue);
  }

  whenReady(): Promise<void> {
    if (this.lifecycleValue === "active" || this.lifecycleValue === "backgrounded") {
      return Promise.resolve();
    }
    if (this.isTerminalOrStopping) {
      return Promise.reject(
        this.terminalErrorValue ?? lifecycleError(
          "invalid_lifecycle_state",
          `Room session cannot become ready after it is ${this.lifecycleValue}`,
        ),
      );
    }
    return new Promise<void>((resolve, reject) => {
      this.readyWaiters.add({ resolve, reject });
    });
  }

  start(connect: () => Promise<void>): Promise<void> {
    if (this.isTerminalOrStopping) {
      return Promise.reject(lifecycleError(
        "invalid_lifecycle_state",
        `Room session is single-use and cannot start after it is ${this.lifecycleValue}`,
      ));
    }
    if (this.startPromise) return this.startPromise;
    this.runningValue = true;
    this.transition("starting");
    const operation = connect().then(() => {
      if (this.lifecycleValue === "stopping" || this.lifecycleValue === "stopped") {
        throw lifecycleError("start_cancelled", "Room session start was cancelled by stop");
      }
      if (this.lifecycleValue === "starting") this.transition("joining");
    }).catch((cause: unknown) => {
      if (cause instanceof CanvasConsumerError && cause.code === "start_cancelled") {
        throw cause;
      }
      if (this.lifecycleValue === "stopping" || this.lifecycleValue === "stopped") {
        throw lifecycleError(
          "start_cancelled",
          "Room session start was cancelled by stop",
          { cause },
        );
      }
      const error = lifecycleError(
        "transport_connection_failed",
        cause instanceof Error ? cause.message : "Room transport failed to connect",
        { source: "transport", cause },
      );
      this.fail(error);
      throw error;
    });
    this.startPromise = operation;
    return operation;
  }

  transportStatus(status: TransportStatus, detail?: string): void {
    if (this.isTerminalOrStopping) return;
    switch (status) {
      case "credentials":
        break;
      case "connecting":
        if (this.lifecycleValue === "idle") this.transition("starting", detail);
        break;
      case "open":
        this.generationValue++;
        this.options.emit({
          type: "connectionReset",
          generation: this.generationValue,
          reason: "open",
        });
        this.transition("joining", detail);
        break;
      case "reconnecting":
        this.generationValue++;
        this.pendingJoin = undefined;
        this.options.emit({
          type: "connectionReset",
          generation: this.generationValue,
          reason: "reconnecting",
        });
        this.transition("reconnecting", detail);
        break;
      case "failed":
        this.fail(lifecycleError(
          "transport_reconnect_exhausted",
          detail || "Room transport exhausted its reconnect attempts",
          { source: "transport" },
        ));
        break;
      case "closed":
        this.fail(lifecycleError(
          "transport_closed",
          detail || "Room transport closed unexpectedly",
          { source: "transport" },
        ));
        break;
      case "idle":
        break;
    }
  }

  joined(canvas: CanvasDefinition, snapshot: CanvasSnapshot, wasSleeping: boolean): void {
    if (this.isTerminalOrStopping) return;
    const join: ConnectionJoin = {
      generation: this.generationValue,
      canvas,
      snapshot,
      wasSleeping,
    };
    this.pendingJoin = join;
    if (this.consumerInitialized) {
      this.completeJoin(join);
      return;
    }
    if (this.consumerInitialization) return;
    this.consumerInitialization = this.initialize(join);
  }

  setPageVisible(visible: boolean): boolean {
    if (this.isTerminalOrStopping || this.pageVisibleValue === visible) return false;
    this.pageVisibleValue = visible;
    if (!visible && this.lifecycleValue === "active") {
      this.transition("backgrounded");
    } else if (visible && this.lifecycleValue === "backgrounded") {
      this.transition("active");
    }
    return true;
  }

  beginStop(): boolean {
    if (this.isTerminalOrStopping) return false;
    this.runningValue = false;
    this.pendingJoin = undefined;
    this.clearSchedules();
    this.generationValue++;
    this.transition("stopping");
    return true;
  }

  finishStop(): void {
    if (this.lifecycleValue !== "stopping") return;
    this.transition("stopped");
    this.observers.clear();
  }

  fail(error: CanvasConsumerError): boolean {
    if (this.lifecycleValue === "failed" || this.lifecycleValue === "stopped") return false;
    this.runningValue = false;
    this.pendingJoin = undefined;
    this.clearSchedules();
    this.generationValue++;
    this.terminalErrorValue = error;
    this.transition("failed", error.message);
    this.options.emit({ type: "failed", error });
    return true;
  }

  private async initialize(firstJoin: ConnectionJoin): Promise<void> {
    try {
      this.options.validateJoin?.(firstJoin.canvas, firstJoin.snapshot);
      await this.options.initializeConsumer?.(
        firstJoin.canvas,
        firstJoin.snapshot,
        firstJoin.wasSleeping,
      );
      if (this.isTerminalOrStopping) return;
      this.consumerInitialized = true;
      this.initializedCanvas = Object.freeze({
        id: firstJoin.canvas.id,
        version: firstJoin.canvas.version,
      });
      const pending = this.pendingJoin;
      if (pending) this.completeJoin(pending);
    } catch (cause) {
      if (this.isTerminalOrStopping) return;
      this.fail(lifecycleError(
        "join_initialization_failed",
        cause instanceof Error ? cause.message : "Room initialization failed",
        { source: "initialization", cause },
      ));
    }
  }

  private completeJoin(join: ConnectionJoin): void {
    if (
      this.isTerminalOrStopping ||
      join !== this.pendingJoin ||
      join.generation !== this.generationValue
    ) return;
    try {
      this.options.validateJoin?.(join.canvas, join.snapshot);
      const initialized = this.initializedCanvas;
      if (
        initialized &&
        (initialized.id !== join.canvas.id || initialized.version !== join.canvas.version)
      ) {
        throw new Error(
          `rejoined canvas '${join.canvas.id}' v${join.canvas.version} after initializing ` +
          `'${initialized.id}' v${initialized.version}`,
        );
      }
      this.options.installJoin(join);
      this.pendingJoin = undefined;
      this.transition(this.pageVisibleValue ? "active" : "backgrounded");
    } catch (cause) {
      this.fail(lifecycleError(
        "join_initialization_failed",
        cause instanceof Error ? cause.message : "Room initialization failed",
        { source: "initialization", cause },
      ));
    }
  }

  private transition(state: CanvasLifecycleState, detail?: string): void {
    if (this.lifecycleValue === state && this.snapshotValue.detail === detail) return;
    const previousState = this.lifecycleValue;
    this.lifecycleValue = state;
    this.snapshotValue = Object.freeze({ state, previousState, detail });
    this.observers.publish(this.snapshotValue);

    if (state === "active" || state === "backgrounded") {
      for (const waiter of this.readyWaiters) waiter.resolve();
      this.readyWaiters.clear();
    } else if (state === "failed" || state === "stopped") {
      const error = this.terminalErrorValue ?? lifecycleError(
        "invalid_lifecycle_state",
        `Room session cannot become ready after it is ${state}`,
      );
      for (const waiter of this.readyWaiters) waiter.reject(error);
      this.readyWaiters.clear();
    }
  }

  private clearSchedules(): void {
    for (const schedule of this.schedules) this.clock.clearInterval(schedule);
    this.schedules = [];
  }
}
