import { describe, expect, it, vi } from "vitest";
import { SimulationDriver, type SimulationListener } from "../src/simulation/driver.js";

describe("SimulationDriver observers", () => {
  it("keeps worker delivery alive when one listener throws", () => {
    let deliver: SimulationListener | undefined;
    const driver = new SimulationDriver((post) => {
      deliver = post;
      return { send: vi.fn(), terminate: vi.fn() };
    });
    const owner = new AbortController();
    const healthy = vi.fn();
    driver.onMessage(() => {
      throw new Error("broken diagnostic listener");
    });
    driver.onMessage(healthy, { signal: owner.signal });
    const message = { type: "error", message: "worker event" } as const;

    expect(() => deliver?.(message)).not.toThrow();
    expect(healthy).toHaveBeenCalledWith(message);

    owner.abort();
    deliver?.(message);
    expect(healthy).toHaveBeenCalledOnce();
  });
});
