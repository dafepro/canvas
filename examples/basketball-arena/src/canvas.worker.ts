/// <reference lib="webworker" />

import { installSimulationWorker } from "@canvas-physics/client/worker-runtime";
import { BasketballBehavior } from "./basketball-behavior.js";

installSimulationWorker(self, [BasketballBehavior]);
