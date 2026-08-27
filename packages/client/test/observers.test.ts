import { describe, expect, it, vi } from "vitest";
import { ObserverSet } from "../src/runtime/observers.js";

describe("ObserverSet", () => {
  it("owns duplicate listener registrations independently", () => {
    const observers = new ObserverSet<number>();
    const observer = vi.fn();
    const first = observers.subscribe(observer);
    const second = observers.subscribe(observer);

    observers.publish(1);
    expect(observer).toHaveBeenCalledTimes(2);
    expect(second).not.toBe(first);

    second();
    observers.publish(2);
    expect(observer).toHaveBeenCalledTimes(3);

    first();
    observers.publish(3);
    expect(observer).toHaveBeenCalledTimes(3);
  });

  it("does not retain or replay a pre-aborted subscription", () => {
    const observers = new ObserverSet<number>();
    const owner = new AbortController();
    const observer = vi.fn();
    owner.abort();

    observers.subscribe(observer, { signal: owner.signal }, () => 1);
    observers.publish(2);
    expect(observer).not.toHaveBeenCalled();
  });
});
