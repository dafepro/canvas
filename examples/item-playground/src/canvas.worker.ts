/// <reference lib="webworker" />

import { installSimulationWorker } from "@canvas-physics/client/worker-runtime";
import { ReactiveOrbBehavior } from "./reactive-orb-behavior.js";
import { LiveBouncerBehavior } from "./live-bouncer-behavior.js";

installSimulationWorker(self, [ReactiveOrbBehavior, LiveBouncerBehavior]);
