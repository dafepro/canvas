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
  }

  updateAssets(progress: Readonly<AssetProgress>): void {
    if (this.phaseValue !== "assets") return;
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
