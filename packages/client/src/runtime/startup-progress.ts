import type { AssetProgress } from "../assets/index.js";
import {
  lifecycleError,
  type CanvasConsumerError,
} from "./lifecycle.js";

export type RuntimeStartupActivePhase =
  | "assets"
  | "credentials"
  | "connecting"
  | "joining"
  | "simulation"
  | "canonical"
  | "presenting"
  | "ready";

export type RuntimeStartupPhase =
  | RuntimeStartupActivePhase
  | "failed"
  | "cancelled";

export interface RuntimeStartupPhaseTiming {
  readonly phase: RuntimeStartupActivePhase;
  readonly startedAtMs: number;
  readonly completedAtMs: number;
}

export interface RuntimeStartupSnapshot {
  readonly phase: RuntimeStartupPhase;
  readonly startedAtMs: number;
  readonly phaseStartedAtMs: number;
  readonly completedAtMs?: number;
  readonly completedPhases: readonly Readonly<RuntimeStartupPhaseTiming>[];
  readonly assets?: Readonly<AssetProgress>;
  readonly error?: CanvasConsumerError;
}

export type RuntimeStartupObserver = (
  snapshot: Readonly<RuntimeStartupSnapshot>,
) => void;

const phaseOrder: readonly RuntimeStartupActivePhase[] = [
  "assets",
  "credentials",
  "connecting",
  "joining",
  "simulation",
  "canonical",
  "presenting",
  "ready",
];

const activePhaseIndex = (phase: RuntimeStartupActivePhase): number =>
  phaseOrder.indexOf(phase);

const freezeAssets = (progress: Readonly<AssetProgress>): Readonly<AssetProgress> =>
  Object.freeze({
    settled: progress.settled,
    total: progress.total,
    ratio: progress.ratio,
    sources: Object.freeze(progress.sources.map((source) => Object.freeze({ ...source }))),
  });

const sameAssets = (
  left: Readonly<AssetProgress> | undefined,
  right: Readonly<AssetProgress>,
): boolean => left?.settled === right.settled && left.total === right.total &&
  left.ratio === right.ratio && left.sources.length === right.sources.length &&
  left.sources.every((source, index) => {
    const candidate = right.sources[index];
    return source.sourceId === candidate?.sourceId &&
      source.required === candidate.required && source.status === candidate.status;
  });

/** Internal monotonic state machine behind the public startup snapshot stream. */
export class StartupProgress {
  private readonly observers = new Set<RuntimeStartupObserver>();
  private readonly startedAtMs: number;
  private phaseStartedAtMs: number;
  private phaseValue: RuntimeStartupPhase;
  private completedAtMs?: number;
  private completedPhasesValue: readonly Readonly<RuntimeStartupPhaseTiming>[] = Object.freeze([]);
  private assetsValue?: Readonly<AssetProgress>;
  private errorValue?: CanvasConsumerError;
  private snapshotValue: Readonly<RuntimeStartupSnapshot>;
  private readonly readyWaiters = new Set<{
    resolve: () => void;
    reject: (error: CanvasConsumerError) => void;
  }>();

  constructor(
    initialPhase: RuntimeStartupActivePhase,
    private readonly now: () => number = () => Date.now(),
  ) {
    this.startedAtMs = now();
    this.phaseStartedAtMs = this.startedAtMs;
    this.phaseValue = initialPhase;
    this.snapshotValue = this.createSnapshot();
  }

  get snapshot(): Readonly<RuntimeStartupSnapshot> {
    return this.snapshotValue;
  }

  subscribe(observer: RuntimeStartupObserver): () => void {
    this.observers.add(observer);
    this.notify(observer);
    return () => this.observers.delete(observer);
  }

  waitUntilReady(): Promise<void> {
    if (this.phaseValue === "ready") return Promise.resolve();
    if (this.isTerminal) {
      return Promise.reject(this.errorValue ?? lifecycleError(
        "invalid_lifecycle_state",
        `Runtime startup ended as ${this.phaseValue}`,
      ));
    }
    return new Promise<void>((resolve, reject) => {
      this.readyWaiters.add({ resolve, reject });
    });
  }

  advance(phase: RuntimeStartupActivePhase): void {
    if (this.isTerminal || this.phaseValue === "ready") return;
    const current = this.phaseValue as RuntimeStartupActivePhase;
    if (activePhaseIndex(phase) <= activePhaseIndex(current)) return;
    const atMs = this.now();
    this.completedPhasesValue = Object.freeze([
      ...this.completedPhasesValue,
      Object.freeze({
        phase: current,
        startedAtMs: this.phaseStartedAtMs,
        completedAtMs: atMs,
      }),
    ]);
    this.phaseValue = phase;
    this.phaseStartedAtMs = atMs;
    if (phase === "ready") this.completedAtMs = atMs;
    this.publish();
    if (phase === "ready") {
      for (const waiter of this.readyWaiters) waiter.resolve();
      this.readyWaiters.clear();
    }
  }

  updateAssets(progress: Readonly<AssetProgress>): void {
    if (this.phaseValue !== "assets") return;
    if (sameAssets(this.assetsValue, progress)) return;
    this.assetsValue = freezeAssets(progress);
    this.publish();
  }

  fail(error: CanvasConsumerError): void {
    this.terminate("failed", error);
  }

  cancel(message = "Runtime startup was cancelled by stop"): void {
    this.terminate("cancelled", lifecycleError("start_cancelled", message));
  }

  private get isTerminal(): boolean {
    return this.phaseValue === "failed" || this.phaseValue === "cancelled";
  }

  private terminate(
    phase: "failed" | "cancelled",
    error: CanvasConsumerError,
  ): void {
    if (this.isTerminal || this.phaseValue === "ready") return;
    const atMs = this.now();
    const current = this.phaseValue as RuntimeStartupActivePhase;
    this.completedPhasesValue = Object.freeze([
      ...this.completedPhasesValue,
      Object.freeze({
        phase: current,
        startedAtMs: this.phaseStartedAtMs,
        completedAtMs: atMs,
      }),
    ]);
    this.phaseValue = phase;
    this.phaseStartedAtMs = atMs;
    this.completedAtMs = atMs;
    this.errorValue = error;
    this.publish();
    for (const waiter of this.readyWaiters) waiter.reject(error);
    this.readyWaiters.clear();
  }

  private publish(): void {
    this.snapshotValue = this.createSnapshot();
    for (const observer of this.observers) this.notify(observer);
  }

  private notify(observer: RuntimeStartupObserver): void {
    try {
      observer(this.snapshotValue);
    } catch {
      // A presentation callback cannot corrupt startup state or other observers.
    }
  }

  private createSnapshot(): Readonly<RuntimeStartupSnapshot> {
    return Object.freeze({
      phase: this.phaseValue,
      startedAtMs: this.startedAtMs,
      phaseStartedAtMs: this.phaseStartedAtMs,
      completedAtMs: this.completedAtMs,
      completedPhases: this.completedPhasesValue,
      assets: this.assetsValue,
      error: this.errorValue,
    });
  }
}

/** Composes browser-owned assets and first render with a headless room stream. */
export class RuntimeStartupProgressCoordinator {
  private readonly progress: StartupProgress;
  private assetsComplete = false;
  private pendingSession?: Readonly<RuntimeStartupSnapshot>;
  private awaitingPresentedFrame = false;

  constructor(now: () => number = () => Date.now()) {
    this.progress = new StartupProgress("assets", now);
  }

  get snapshot(): Readonly<RuntimeStartupSnapshot> {
    return this.progress.snapshot;
  }

  subscribe(observer: RuntimeStartupObserver): () => void {
    return this.progress.subscribe(observer);
  }

  waitUntilReady(): Promise<void> {
    return this.progress.waitUntilReady();
  }

  configureAssets(sources: readonly Readonly<{ id: string; required: boolean }>[]): void {
    this.updateAssets({
      settled: 0,
      total: sources.length,
      ratio: sources.length === 0 ? 1 : 0,
      sources: sources.map((source) => ({
        sourceId: source.id,
        required: source.required,
        status: "pending",
      })),
    });
  }

  updateAssets(assets: Readonly<AssetProgress>): void {
    this.progress.updateAssets(assets);
  }

  completeAssets(): void {
    if (this.assetsComplete) return;
    this.assetsComplete = true;
    if (this.pendingSession) this.applySession(this.pendingSession);
    else this.progress.advance("credentials");
  }

  acceptSession(snapshot: Readonly<RuntimeStartupSnapshot>): void {
    this.pendingSession = snapshot;
    if (this.assetsComplete) this.applySession(snapshot);
  }

  markPresentedFrame(): void {
    if (!this.awaitingPresentedFrame) return;
    this.awaitingPresentedFrame = false;
    this.progress.advance("ready");
  }

  fail(error: CanvasConsumerError): void {
    this.progress.fail(error);
  }

  cancel(): void {
    this.progress.cancel();
  }

  private applySession(snapshot: Readonly<RuntimeStartupSnapshot>): void {
    switch (snapshot.phase) {
      case "assets":
        return;
      case "ready":
        this.progress.advance("presenting");
        this.awaitingPresentedFrame = true;
        return;
      case "failed":
        if (snapshot.error) this.progress.fail(snapshot.error);
        return;
      case "cancelled":
        this.progress.cancel();
        return;
      case "presenting":
        this.progress.advance("presenting");
        return;
      case "credentials":
      case "connecting":
      case "joining":
      case "simulation":
      case "canonical":
        this.progress.advance(snapshot.phase);
        return;
    }
  }
}
