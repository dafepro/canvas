import {
  CanvasRuntime,
  SimulationDriver,
  devRealtimeCredential,
  type CanonicalStateSnapshot,
} from "@canvas-physics/client";
import { soccerDefinitions } from "./soccer-content.js";
import type { SoccerBallState } from "./soccer-ball-behavior.js";
import "./style.css";

const serverUrl =
  import.meta.env.VITE_SERVER_URL ?? `${location.protocol}//${location.hostname}:8082`;

const stage = document.querySelector<HTMLElement>("#stage")!;
const userInput = document.querySelector<HTMLInputElement>("#user")!;
const joinButton = document.querySelector<HTMLButtonElement>("#join")!;
const leaveButton = document.querySelector<HTMLButtonElement>("#leave")!;
const ballButton = document.querySelector<HTMLButtonElement>("#place-ball")!;
const benchButton = document.querySelector<HTMLButtonElement>("#bench")!;
const homeScore = document.querySelector<HTMLElement>("#home-score")!;
const awayScore = document.querySelector<HTMLElement>("#away-score")!;
const status = document.querySelector<HTMLElement>("#status")!;
const participantCount = document.querySelector<HTMLElement>("#participant-count")!;
const scoreBoard = document.querySelector<HTMLElement>("#scoreboard")!;

userInput.value =
  new URLSearchParams(location.search).get("user") ??
  `player-${Math.random().toString(36).slice(2, 6)}`;

let runtime: CanvasRuntime | undefined;
let ballIds = new Set<string>();
let unsubscribers: (() => void)[] = [];

const renderScore = (state: SoccerBallState): void => {
  homeScore.textContent = String(state.homeScore);
  awayScore.textContent = String(state.awayScore);
  scoreBoard.dataset.phase = state.phase;
};

const observeEntities = (snapshot: CanonicalStateSnapshot): void => {
  ballIds = new Set(
    snapshot.entities
      .filter((entity) => entity.kind === "item" && entity.definitionId === "soccer-ball")
      .map((entity) => entity.id),
  );
  ballButton.disabled = ballIds.size > 0;
  ballButton.textContent = ballIds.size > 0 ? "Match ball is live" : "Place match ball";
};

const join = async (): Promise<void> => {
  if (runtime) return;
  joinButton.disabled = true;
  status.textContent = "Joining…";

  const worker = new Worker(new URL("./canvas.worker.ts", import.meta.url), {
    type: "module",
    name: "soccer-lounge-simulation",
  });
  const nextRuntime = new CanvasRuntime({
    canvasId: "soccer-lounge",
    serverUrl,
    credentialProvider: async () =>
      devRealtimeCredential(userInput.value, userInput.value),
    mount: stage,
    definitions: soccerDefinitions,
    driver: new SimulationDriver(worker),
    scene: {
      background: 0x165c31,
      debug: new URLSearchParams(location.search).has("debug"),
    },
    onAvatarDisabledChange: (disabled) => {
      benchButton.textContent = disabled ? "Return to play" : "Take a break";
      benchButton.classList.toggle("active", disabled);
    },
    onDiagnostics: (diagnostics) => {
      status.textContent = diagnostics.isHost
        ? `Simulation host · tick ${diagnostics.tick}`
        : `Peer · tick ${diagnostics.tick}`;
    },
  });
  runtime = nextRuntime;

  unsubscribers = [
    nextRuntime.subscribeCanonicalState(observeEntities),
    nextRuntime.subscribeBehaviorState((snapshot) => {
      const score = snapshot.states.find((entry) => ballIds.has(entry.entityId));
      if (score) renderScore(score.state as SoccerBallState);
    }),
    nextRuntime.subscribePresence((snapshot) => {
      participantCount.textContent = String(snapshot.participants.length);
    }),
    nextRuntime.subscribeEffects((effect) => {
      if (effect.effect !== "goal") return;
      scoreBoard.classList.remove("goal-flash");
      requestAnimationFrame(() => scoreBoard.classList.add("goal-flash"));
    }),
  ];

  try {
    await nextRuntime.start();
    leaveButton.disabled = false;
    benchButton.disabled = false;
    ballButton.disabled = false;
  } catch (error) {
    runtime = undefined;
    nextRuntime.stop();
    unsubscribers.forEach((unsubscribe) => unsubscribe());
    unsubscribers = [];
    joinButton.disabled = false;
    status.textContent = `Join failed: ${String(error)}`;
  }
};

const leave = (): void => {
  const leaving = runtime;
  runtime = undefined;
  unsubscribers.forEach((unsubscribe) => unsubscribe());
  unsubscribers = [];
  void (leaving?.stopGracefully() ?? Promise.resolve()).finally(() => {
    for (const canvas of stage.querySelectorAll("canvas")) canvas.remove();
    joinButton.disabled = false;
  });
  leaveButton.disabled = true;
  ballButton.disabled = true;
  benchButton.disabled = true;
  status.textContent = "Not connected";
  participantCount.textContent = "0";
};

joinButton.addEventListener("click", () => void join());
leaveButton.addEventListener("click", leave);
ballButton.addEventListener("click", () => {
  runtime?.spawnItem("soccer-ball", { x: 60, y: 36 });
});
benchButton.addEventListener("click", () => runtime?.toggleAvatarDisabled());

if (new URLSearchParams(location.search).has("autojoin")) void join();
