/// <reference lib="webworker" />

import { installSimulationWorker } from "@canvas-physics/client/worker-runtime";
import { ReactiveOrbBehavior } from "./reactive-orb-behavior.js";

installSimulationWorker(self, [ReactiveOrbBehavior]);
