import { describe, expect, it, vi } from "vitest";
import { ConnectionSession } from "../src/runtime/session/connection-session.js";
import type { CanvasLifecycleState } from "../src/runtime/lifecycle.js";

type Event = "connecting" | "open" | "reconnecting" | "failed" | "stop";

interface Model {
  lifecycle: CanvasLifecycleState;
  generation: number;
  terminal: boolean;
}

const events: readonly Event[] = [
  "connecting",
  "open",
  "reconnecting",
  "failed",
  "stop",
];

const traces = (depth: number): Event[][] => {
  let result: Event[][] = [[]];
  for (let index = 0; index < depth; index++) {
    result = result.flatMap((trace) => events.map((event) => [...trace, event]));
  }
  return result;
};

const reduce = (model: Model, event: Event): Model => {
  if (model.terminal) return model;
  switch (event) {
    case "connecting":
      return model.lifecycle === "idle" ? { ...model, lifecycle: "starting" } : model;
    case "open":
      return { ...model, lifecycle: "joining", generation: model.generation + 1 };
    case "reconnecting":
      return { ...model, lifecycle: "reconnecting", generation: model.generation + 1 };
    case "failed":
      return {
        lifecycle: "failed",
        generation: model.generation + 1,
        terminal: true,
      };
    case "stop":
      return {
        lifecycle: "stopped",
        generation: model.generation + 1,
        terminal: true,
      };
  }
};

describe("session transition model", () => {
  it("matches every bounded connection trace and never leaves a terminal state", () => {
    for (const trace of traces(5)) {
      const connection = new ConnectionSession({ installJoin: vi.fn(), emit: vi.fn() });
      let model: Model = { lifecycle: "idle", generation: 0, terminal: false };
      for (const event of trace) {
        model = reduce(model, event);
        if (event === "stop") {
          if (connection.beginStop()) connection.finishStop();
        } else {
          connection.transportStatus(event, event === "failed" ? "fault" : undefined);
        }
        expect(
          {
            lifecycle: connection.lifecycleState,
            generation: connection.generation,
            terminal: connection.lifecycleState === "failed" ||
              connection.lifecycleState === "stopped",
          },
          `trace: ${trace.join(" -> ")}`,
        ).toEqual(model);
      }
    }
  });
});
