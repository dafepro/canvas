/// <reference lib="webworker" />

import { installSimulationWorker } from "@canvas-physics/client/worker-runtime";
import { ReactiveOrbBehavior } from "./reactive-orb-behavior.js";
import { LiveBouncerBehavior } from "./live-bouncer-behavior.js";
import { PairedPortalBehavior } from "./paired-portal-behavior.js";
import { ForceFieldBehavior } from "./force-field-behavior.js";

installSimulationWorker(self, [
  ReactiveOrbBehavior,
  LiveBouncerBehavior,
  PairedPortalBehavior,
  ForceFieldBehavior,
]);
