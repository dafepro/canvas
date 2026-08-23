export interface FrameProfile {
  samples: number;
  p95Ms: number;
  worstMs: number;
  longFrames: number;
}

export interface FrameProfilerOptions {
  /** Roughly five seconds at 60 FPS by default. */
  maxSamples?: number;
  /** A frame slower than 30 FPS is long by default. */
  longFrameMs?: number;
}

/** Rolling render timing statistics for repeatable device profiling. */
export class FrameProfiler {
  private readonly maxSamples: number;
  private readonly longFrameMs: number;
  private readonly samples: number[] = [];

  constructor(options: FrameProfilerOptions = {}) {
    this.maxSamples = Math.max(1, Math.floor(options.maxSamples ?? 300));
    this.longFrameMs = options.longFrameMs ?? 1000 / 30;
  }

  sample(frameMs: number): void {
    if (!Number.isFinite(frameMs) || frameMs <= 0) return;
    this.samples.push(frameMs);
    if (this.samples.length > this.maxSamples) this.samples.shift();
  }

  reset(): void {
    this.samples.length = 0;
  }

  diagnostics(): FrameProfile {
    if (this.samples.length === 0) {
      return { samples: 0, p95Ms: 0, worstMs: 0, longFrames: 0 };
    }
    const sorted = [...this.samples].sort((a, b) => a - b);
    const p95Index = Math.ceil(sorted.length * 0.95) - 1;
    return {
      samples: sorted.length,
      p95Ms: sorted[p95Index]!,
      worstMs: sorted.at(-1)!,
      longFrames: sorted.filter((frameMs) => frameMs > this.longFrameMs).length,
    };
  }
}
