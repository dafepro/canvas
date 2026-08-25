import { describe, expect, it, vi } from "vitest";
import { CanvasConsumerError } from "../src/runtime/lifecycle.js";
import { PresentationGate } from "../src/runtime/session/presentation-gate.js";

describe("PresentationGate", () => {
  it("resolves only when one generation has simulation, presence, items, and canonical IDs", async () => {
    const gate = new PresentationGate();
    const presented = vi.fn();
    void gate.wait().then(presented);
    gate.resetConnection(2);
    gate.markPresence(2, ["avatar:alice"]);
    gate.markItems(2, ["ball"]);
    gate.markCanonical(2, ["avatar:alice", "ball"]);
    await Promise.resolve();
    expect(presented).not.toHaveBeenCalled();

    gate.markSimulationReady(2);
    await gate.wait();
    expect(gate.presented).toBe(true);
    expect(gate.authoritativeCurrent).toBe(true);
  });

  it("cannot combine stale facts across reconnect generations", async () => {
    const gate = new PresentationGate();
    gate.resetConnection(1);
    gate.markSimulationReady(1);
    gate.markPresence(1, ["avatar:alice"]);
    gate.markItems(1, ["ball"]);
    gate.resetConnection(2);
    gate.markCanonical(2, ["avatar:alice", "ball"]);

    let resolved = false;
    void gate.wait().then(() => { resolved = true; });
    await Promise.resolve();
    expect(resolved).toBe(false);

    gate.markSimulationReady(2);
    gate.markPresence(2, ["avatar:alice"]);
    gate.markItems(2, ["ball"]);
    await gate.wait();
    expect(resolved).toBe(true);
  });

  it("keeps public presentation sticky while tracking reconnect currency", async () => {
    const gate = new PresentationGate();
    gate.resetConnection(1);
    gate.markSimulationReady(1);
    gate.markPresence(1, []);
    gate.markItems(1, []);
    gate.markCanonical(1, []);
    await gate.wait();

    gate.resetConnection(2);

    expect(gate.presented).toBe(true);
    expect(gate.authoritativeCurrent).toBe(false);
    await expect(gate.wait()).resolves.toBeUndefined();
  });

  it("rejects every waiter once on terminal failure", async () => {
    const gate = new PresentationGate();
    const first = gate.wait();
    const second = gate.wait();
    const error = new CanvasConsumerError({
      code: "server_rejected",
      message: "duplicate",
      source: "protocol",
      recoverable: false,
    });

    gate.fail(error);
    gate.fail(new CanvasConsumerError({
      code: "transport_closed",
      message: "late",
      source: "transport",
      recoverable: false,
    }));

    await expect(first).rejects.toBe(error);
    await expect(second).rejects.toBe(error);
    await expect(gate.wait()).rejects.toBe(error);
  });
});
