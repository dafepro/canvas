/// <reference lib="webworker" />

import { installSimulationWorker } from "@canvas-physics/client/worker-runtime";
import { SoccerBallBehavior } from "./soccer-ball-behavior.js";

installSimulationWorker(self, [SoccerBallBehavior]);
