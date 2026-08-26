import { describe, expect, it } from "vitest";
import { formatStartupStatus } from "../examples/shared/startup-status.js";
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
    expect(formatStartupStatus(snapshot("assets", {
      assets: { settled: 4, total: 4, ratio: 1, sources: [] },
    }), { assetName: "arena art" })).toBe("Loading arena art… 4/4");
    expect(formatStartupStatus(snapshot("credentials"))).toBe("Requesting room access…");
    expect(formatStartupStatus(snapshot("connecting"))).toBe("Opening realtime connection…");
    expect(formatStartupStatus(snapshot("joining"))).toBe("Joining room…");
    expect(formatStartupStatus(snapshot("simulation"))).toBe("Starting physics simulation…");
    expect(formatStartupStatus(snapshot("canonical"))).toBe(
      "Syncing authoritative room state…",
    );
    expect(formatStartupStatus(snapshot("presenting"))).toBe("Preparing first frame…");
    expect(formatStartupStatus(snapshot("ready"), { readyMessage: "Play" })).toBe("Play");
  });
});
