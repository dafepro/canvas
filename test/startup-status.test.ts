import { describe, expect, it } from "vitest";
import { formatRuntimeStartupStatus } from "../packages/client/src/runtime/startup-status.js";
import type { RuntimeStartupSnapshot } from "@canvas-physics/client/runtime";

const snapshot = (
  phase: RuntimeStartupSnapshot["phase"],
  extra: Partial<RuntimeStartupSnapshot> = {},
): RuntimeStartupSnapshot => ({
  phase,
  startedAtMs: 1,
  phaseStartedAtMs: 1,
  completedPhases: [],
  ...extra,
});

describe("example startup status", () => {
  it("names every semantic wait instead of treating asset completion as readiness", () => {
    expect(formatRuntimeStartupStatus(snapshot("assets", {
      assets: { settled: 4, total: 4, ratio: 1, sources: [] },
    }), { assetName: "arena art" })).toBe("Loading arena art… 4/4");
    expect(formatRuntimeStartupStatus(snapshot("credentials"))).toBe("Requesting room access…");
    expect(formatRuntimeStartupStatus(snapshot("connecting"))).toBe("Opening realtime connection…");
    expect(formatRuntimeStartupStatus(snapshot("joining"))).toBe("Joining room…");
    expect(formatRuntimeStartupStatus(snapshot("simulation"))).toBe("Starting physics simulation…");
    expect(formatRuntimeStartupStatus(snapshot("canonical"))).toBe(
      "Syncing authoritative room state…",
    );
    expect(formatRuntimeStartupStatus(snapshot("presenting"))).toBe("Preparing first frame…");
    expect(formatRuntimeStartupStatus(snapshot("ready"), { readyMessage: "Play" })).toBe("Play");
  });
});
