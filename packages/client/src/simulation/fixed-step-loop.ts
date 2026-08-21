export interface FixedStepStats {
  /** Steps run in the last drive call. */
  steps: number;
  /** Accumulated time the loop has not yet simulated, in milliseconds. */
  driftMs: number;
  /** Measured step rate over the last second. */
  hz: number;
  /** Longest single step in milliseconds. */
  worstStepMs: number;
}

/**
 * Spec 10.3. A fixed step, never a variable dt. When the loop falls far behind,
 * it drops the backlog instead of running an unbounded catch-up burst.
 */
export class FixedStepLoop {
  private accumulatorMs = 0;
  private lastNowMs = 0;
  private stepsThisSecond = 0;
  private secondStartedMs = 0;
  private measuredHz = 0;
  private worstStepMs = 0;

  constructor(
    readonly tickRate: number,
    private readonly step: () => void,
    /** Maximum steps in one drive call, so a long pause cannot freeze the tab. */
    private readonly maxStepsPerDrive = 5,
  ) {}

  get stepMs(): number {
    return 1000 / this.tickRate;
  }

  reset(nowMs: number): void {
    this.accumulatorMs = 0;
    this.lastNowMs = nowMs;
    this.secondStartedMs = nowMs;
    this.stepsThisSecond = 0;
  }

  /** Call once per animation frame or timer tick. */
  drive(nowMs: number): FixedStepStats {
    if (this.lastNowMs === 0) this.reset(nowMs);
    this.accumulatorMs += nowMs - this.lastNowMs;
    this.lastNowMs = nowMs;

    let steps = 0;
    this.worstStepMs = 0;
    while (this.accumulatorMs >= this.stepMs && steps < this.maxStepsPerDrive) {
      const startedMs = nowMs;
      this.step();
      this.worstStepMs = Math.max(this.worstStepMs, performance.now() - startedMs);
      this.accumulatorMs -= this.stepMs;
      steps++;
      this.stepsThisSecond++;
    }
    // Drop a backlog the loop cannot catch up with.
    if (this.accumulatorMs > this.stepMs * this.maxStepsPerDrive * 2) {
      this.accumulatorMs = 0;
    }

    if (nowMs - this.secondStartedMs >= 1000) {
      this.measuredHz = (this.stepsThisSecond * 1000) / (nowMs - this.secondStartedMs);
      this.stepsThisSecond = 0;
      this.secondStartedMs = nowMs;
    }

    return {
      steps,
      driftMs: this.accumulatorMs,
      hz: this.measuredHz,
      worstStepMs: this.worstStepMs,
    };
  }
}
