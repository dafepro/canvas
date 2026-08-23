/// <reference lib="webworker" />
import { installSimulationWorker } from "./worker-runtime.js";

/**
 * Default worker entry point with the Canvas built-in behaviors. Applications
 * that add behavior provide their own entry and call installSimulationWorker.
 */
installSimulationWorker(self);
