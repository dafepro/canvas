import { describe, expect, it } from "vitest";
import {
  resolveItemConfig,
  type ItemBehavior,
  type ItemDefinition,
  type ItemInstance,
} from "@canvas-physics/core";
import {
  installSimulationWorker,
  type SimulationWorkerScope,
} from "../src/simulation/worker-runtime.js";
import {
  runSimulationWorkerConformance,
  type SimulationWorkerConformanceFixture,
} from "../src/testing/index.js";
import type { SimulationRequest, SimulationResponse } from "../src/index.js";
import { rocketCanvas } from "../src/definitions/rocket-canvas.js";

interface CounterState {
  ticks: number;
}

const CounterBehavior = {
  behaviorType: "test.counter",
  stateVersion: 1,
  subscribes: ["tick"],
  initialState: (): CounterState => ({ ticks: 0 }),
  onEvent: (_context, _config, state) => ({
    state: { ticks: state.ticks + 1 },
    commands: [],
  }),
} satisfies ItemBehavior<Record<string, never>, CounterState>;

const counterDefinition: ItemDefinition<Record<string, never>> = {
  definitionId: "counter",
  version: 1,
  displayName: "Counter",
  visual: {
    size: { width: 2, height: 2 },
    placeholder: { shape: "circle", color: 0xffffff },
    zIndex: 1,
  },
  body: { mode: "dynamic", mass: 1, gravityScale: 0 },
  colliders: [
    { id: "solid", role: "itemSolid", shape: { type: "circle", radius: 1 } },
  ],
  behaviorType: CounterBehavior.behaviorType,
  defaultConfig: {},
  persistence: {
    transform: true,
    behaviorState: true,
    onRoomSleep: "preserve",
  },
  complexity: "simple",
};

const counterInstance: ItemInstance = {
  entityId: "counter-1",
  canvasId: rocketCanvas.id,
  definitionId: counterDefinition.definitionId,
  definitionVersion: counterDefinition.version,
  ownerUserId: "tester",
  transform: { x: 50, y: 20, rotation: 0 },
  resolvedConfig: resolveItemConfig(counterDefinition, {
    width: rocketCanvas.size.width,
    height: rocketCanvas.size.height,
    orientation: rocketCanvas.orientation,
  }),
  createdAt: new Date(0).toISOString(),
  sceneRevision: 1,
};

describe("custom simulation worker runtime", () => {
  it("passes the public conformance kit with an application behavior", async () => {
    const fixture: SimulationWorkerConformanceFixture = {
      timeoutMs: 10_000,
      create: () => {
        const listeners = new Set<(message: SimulationResponse) => void>();
        const scope: SimulationWorkerScope = {
          onmessage: null,
          postMessage: (message) => {
            for (const listener of listeners) listener(message);
          },
        };
        const runtime = installSimulationWorker(scope, [CounterBehavior]);
        return {
          postMessage: (data) =>
            scope.onmessage?.({ data } as MessageEvent<SimulationRequest>),
          onMessage: (listener) => {
            listeners.add(listener);
            return () => listeners.delete(listener);
          },
          terminate: () => runtime.stop(),
        };
      },
      init: {
        type: "init",
        generation: 1,
        canvas: rocketCanvas,
        definitions: [counterDefinition],
        tickRate: 60,
        isHost: true,
      },
      scenarios: [{
        name: "custom counter behavior advances",
        exercise: async (worker) => {
          worker.send({ type: "addItem", instance: counterInstance });
          await worker.waitFor((response) => {
            if (response.type !== "render") return false;
            const found = response.entities.find((candidate) => candidate.id === "counter-1");
            const state = found?.behaviorState as CounterState | undefined;
            return Boolean(found && state && state.ticks > 0);
          }, "custom behavior state did not advance");
        },
      }],
    };

    const report = await runSimulationWorkerConformance(fixture);

    expect(report).toEqual({ ok: true, checksRun: 4, scenariosRun: 1, issues: [] });
  });

  it("requires at least one application-owned scenario", async () => {
    const report = await runSimulationWorkerConformance({
      create: () => ({
        postMessage: () => {},
        onMessage: () => () => {},
        terminate: () => {},
      }),
      init: {
        type: "init",
        generation: 1,
        canvas: rocketCanvas,
        definitions: [],
        tickRate: 60,
        isHost: true,
      },
      scenarios: [],
      timeoutMs: 10,
    });

    expect(report.issues).toContainEqual(expect.objectContaining({
      code: "scenario_required",
    }));
  });
});
