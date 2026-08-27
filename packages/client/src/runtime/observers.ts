export type Observer<T> = (value: T) => void;

export interface SubscriptionOptions {
  /** Automatically unsubscribes when the signal aborts. */
  readonly signal?: AbortSignal;
}

export type ObserverErrorHandler = (cause: unknown) => void;

interface ObserverEntry<T> {
  readonly observer: Observer<T>;
  readonly signal?: AbortSignal;
  readonly abort?: () => void;
  readonly unsubscribe: () => void;
}

/** Failure-isolated observer ownership shared by every public client stream. */
export class ObserverSet<T> {
  private readonly entries = new Set<ObserverEntry<T>>();

  constructor(private readonly onError?: ObserverErrorHandler) {}

  subscribe(
    observer: Observer<T>,
    options: SubscriptionOptions = {},
    replay?: () => T,
  ): () => void {
    if (options.signal?.aborted) return () => {};

    let entry: ObserverEntry<T>;
    let active = true;
    const unsubscribe = (): void => {
      if (!active) return;
      active = false;
      this.entries.delete(entry);
      if (entry.signal && entry.abort) {
        entry.signal.removeEventListener("abort", entry.abort);
      }
    };
    entry = {
      observer,
      signal: options.signal,
      abort: options.signal ? unsubscribe : undefined,
      unsubscribe,
    };
    this.entries.add(entry);
    if (entry.signal && entry.abort) {
      entry.signal.addEventListener("abort", entry.abort, { once: true });
    }
    if (replay) this.notify(observer, replay());
    return unsubscribe;
  }

  publish(value: T): void {
    for (const entry of [...this.entries]) {
      if (this.entries.has(entry)) this.notify(entry.observer, value);
    }
  }

  clear(): void {
    for (const entry of [...this.entries.values()]) entry.unsubscribe();
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
