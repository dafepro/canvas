export type Observer<T> = (value: T) => void;

export interface SubscriptionOptions {
  /** Automatically unsubscribes when the signal aborts. */
  readonly signal?: AbortSignal;
}

export type ObserverErrorHandler = (cause: unknown) => void;

interface ObserverEntry<T> {
  readonly observer: Observer<T>;
  readonly aborts: Map<AbortSignal, () => void>;
  readonly unsubscribe: () => void;
}

/** Failure-isolated observer ownership shared by every public client stream. */
export class ObserverSet<T> {
  private readonly entries = new Map<Observer<T>, ObserverEntry<T>>();

  constructor(private readonly onError?: ObserverErrorHandler) {}

  subscribe(
    observer: Observer<T>,
    options: SubscriptionOptions = {},
    replay?: () => T,
  ): () => void {
    if (options.signal?.aborted) return () => {};
    const existing = this.entries.get(observer);
    if (existing) {
      this.attachSignal(existing, options.signal);
      if (replay) this.notify(observer, replay());
      return existing.unsubscribe;
    }

    let entry: ObserverEntry<T>;
    let active = true;
    const unsubscribe = (): void => {
      if (!active) return;
      active = false;
      this.entries.delete(observer);
      for (const [signal, abort] of entry.aborts) {
        signal.removeEventListener("abort", abort);
      }
      entry.aborts.clear();
    };
    entry = {
      observer,
      aborts: new Map(),
      unsubscribe,
    };
    this.entries.set(observer, entry);
    this.attachSignal(entry, options.signal);
    if (replay) this.notify(observer, replay());
    return unsubscribe;
  }

  publish(value: T): void {
    for (const entry of [...this.entries.values()]) {
      if (this.entries.get(entry.observer) === entry) this.notify(entry.observer, value);
    }
  }

  clear(): void {
    for (const entry of [...this.entries.values()]) entry.unsubscribe();
  }

  private attachSignal(entry: ObserverEntry<T>, signal?: AbortSignal): void {
    if (!signal || entry.aborts.has(signal)) return;
    const abort = entry.unsubscribe;
    entry.aborts.set(signal, abort);
    signal.addEventListener("abort", abort, { once: true });
  }

  private notify(observer: Observer<T>, value: T): void {
    try {
      observer(value);
    } catch (cause) {
      try {
        this.onError?.(cause);
      } catch {
        // Error reporting is itself a consumer boundary and cannot recurse.
      }
    }
  }
}
