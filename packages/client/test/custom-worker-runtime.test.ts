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
import type { RenderEntity, SimulationRequest, SimulationResponse } from "../src/index.js";
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

const waitFor = async <T>(read: () => T | undefined, timeoutMs = 10_000): Promise<T> => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = read();
    if (value !== undefined) return value;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("timed out waiting for simulation response");
};

describe("custom simulation worker runtime", () => {
  it("runs an application behavior registered by the worker entry", async () => {
    const responses: SimulationResponse[] = [];
    const scope: SimulationWorkerScope = {
      onmessage: null,
      postMessage: (message) => responses.push(message),
    };
    const runtime = installSimulationWorker(scope, [CounterBehavior]);
    const send = (data: SimulationRequest): void =>
      scope.onmessage?.({ data } as MessageEvent<SimulationRequest>);

    try {
      send({
        type: "init",
        canvas: rocketCanvas,
        definitions: [counterDefinition],
        tickRate: 60,
        isHost: true,
      });
      await waitFor(() => responses.find((response) => response.type === "ready"));
      send({ type: "addItem", instance: counterInstance });

      const entity = await waitFor<RenderEntity>(() => {
        for (const response of responses) {
          if (response.type !== "render") continue;
          const found = response.entities.find((candidate) => candidate.id === "counter-1");
          const state = found?.behaviorState as CounterState | undefined;
          if (found && state && state.ticks > 0) return found;
        }
        return undefined;
      });

      expect(entity.behaviorState).toMatchObject({ ticks: expect.any(Number) });
    } finally {
      runtime.stop();
    }
    expect(scope.onmessage).toBeNull();
  });
});
