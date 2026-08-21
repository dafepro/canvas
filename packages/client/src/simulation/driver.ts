import type { SimulationRequest, SimulationResponse } from "./messages.js";

export type SimulationListener = (message: SimulationResponse) => void;

/** The main-thread handle on the simulation worker. */
export class SimulationDriver {
  private readonly worker: Worker;
  private readonly listeners = new Set<SimulationListener>();

  constructor(worker: Worker) {
    this.worker = worker;
    this.worker.onmessage = (event: MessageEvent<SimulationResponse>) => {
      for (const listener of this.listeners) listener(event.data);
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

  send(request: SimulationRequest): void {
    this.worker.postMessage(request);
  }

  onMessage(listener: SimulationListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  terminate(): void {
    this.send({ type: "stop" });
    this.worker.terminate();
    this.listeners.clear();
  }
}
