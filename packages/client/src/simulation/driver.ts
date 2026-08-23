import type { ItemBehavior } from "@canvas-physics/core";
import { createSimulationBehaviorRegistry } from "./behavior-registry.js";
import { SimulationKernel } from "./kernel.js";
import type { SimulationRequest, SimulationResponse } from "./messages.js";

export type SimulationListener = (message: SimulationResponse) => void;

/** The two ends of the simulation boundary look the same to the driver. */
interface SimulationChannel {
  send(request: SimulationRequest): void;
  terminate(): void;
}

/** The main-thread handle on the simulation. */
export class SimulationDriver {
  private readonly listeners = new Set<SimulationListener>();
  private readonly channel: SimulationChannel;

  constructor(source: Worker | ((post: SimulationListener) => SimulationChannel)) {
    const deliver: SimulationListener = (message) => {
      for (const listener of this.listeners) listener(message);
    };
    if (typeof source === "function") {
      this.channel = source(deliver);
      return;
    }
    const worker = source;
    worker.onmessage = (event: MessageEvent<SimulationResponse>) => deliver(event.data);
    this.channel = {
      send: (request) => worker.postMessage(request),
      terminate: () => worker.terminate(),
    };
  }

  /** Builds a driver from the packaged worker entry point. */
  static spawn(): SimulationDriver {
    const worker = new Worker(new URL("./simulation.worker.js", import.meta.url), {
      type: "module",
      name: "canvas-physics-simulation",
    });
    return new SimulationDriver(worker);
  }

  /**
   * Builds a driver that runs the kernel in this thread. A test uses it to run a
   * full client with no worker. A browser client uses `spawn`.
   */
  static local(
    applicationBehaviors: readonly ItemBehavior<any, any>[] = [],
  ): SimulationDriver {
    return new SimulationDriver((post) => {
      const kernel = new SimulationKernel(
        post,
        createSimulationBehaviorRegistry(applicationBehaviors),
      );
      return {
        send: (request) => kernel.handle(request),
        terminate: () => kernel.stop(),
      };
    });
  }

  send(request: SimulationRequest): void {
    this.channel.send(request);
  }

  onMessage(listener: SimulationListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  terminate(): void {
    this.send({ type: "stop" });
    this.channel.terminate();
    this.listeners.clear();
  }
}
