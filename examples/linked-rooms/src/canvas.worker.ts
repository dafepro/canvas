/// <reference lib="webworker" />

import { installSimulationWorker } from "@canvas-physics/client/worker-runtime";

installSimulationWorker(self);
