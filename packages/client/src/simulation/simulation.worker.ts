/// <reference lib="webworker" />
import { SimulationKernel } from "./kernel.js";
import type { SimulationRequest } from "./messages.js";

/**
 * The worker entry point. Every rule lives in SimulationKernel, so this file is
 * only the bridge between the worker port and the kernel.
 */
const kernel = new SimulationKernel((message) => self.postMessage(message));

self.onmessage = (event: MessageEvent<SimulationRequest>) => {
  kernel.handle(event.data);
};
