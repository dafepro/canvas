import type { ItemBehavior } from "@canvas-physics/core";
import { createSimulationBehaviorRegistry } from "./behavior-registry.js";
import { SimulationKernel } from "./kernel.js";
import type { SimulationRequest, SimulationResponse } from "./messages.js";

/** The minimal worker-global surface used by the simulation runtime. */
export interface SimulationWorkerScope {
  onmessage: ((event: MessageEvent<SimulationRequest>) => void) | null;
  postMessage(message: SimulationResponse): void;
}

export interface InstalledSimulationWorker {
  stop(): void;
}

/**
 * Installs Canvas into an application-owned worker entry point.
 *
 * The application imports its behaviors in that entry point and passes them
 * here. This keeps behavior code in the worker bundle and leaves the runtime
 * protocol data-only.
 */
export const installSimulationWorker = (
  scope: SimulationWorkerScope,
  applicationBehaviors: readonly ItemBehavior<any, any>[] = [],
): InstalledSimulationWorker => {
  const registry = createSimulationBehaviorRegistry(applicationBehaviors);
  const kernel = new SimulationKernel((message) => scope.postMessage(message), registry);
  scope.onmessage = (event) => kernel.handle(event.data);

  return {
    stop: () => {
      scope.onmessage = null;
      kernel.stop();
    },
  };
};
