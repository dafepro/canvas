import type {
  CanvasRuntime,
  CanonicalStateSnapshot,
  OverlayProjectionSnapshot,
  ParticipantPresence,
} from "@canvas-physics/client/runtime";
import { soccerDefinitions } from "./soccer-content.js";
import type { SoccerBallState } from "./soccer-ball-behavior.js";
import { soccerAssets } from "./assets.js";
import { projectSoccerParticipantAvatar } from "./participant-projection.js";
import { playerStarCount } from "./player-overlay.js";
import "./style.css";

const serverUrl =
  import.meta.env.VITE_SERVER_URL ?? `${location.protocol}//${location.hostname}:8082`;

const stage = document.querySelector<HTMLElement>("#stage")!;
const userInput = document.querySelector<HTMLInputElement>("#user")!;
const joinButton = document.querySelector<HTMLButtonElement>("#join")!;
const leaveButton = document.querySelector<HTMLButtonElement>("#leave")!;
const benchButton = document.querySelector<HTMLButtonElement>("#bench")!;
const homeScore = document.querySelector<HTMLElement>("#home-score")!;
const awayScore = document.querySelector<HTMLElement>("#away-score")!;
const status = document.querySelector<HTMLElement>("#status")!;
const participantCount = document.querySelector<HTMLElement>("#participant-count")!;
const scoreBoard = document.querySelector<HTMLElement>("#scoreboard")!;
const ballMarker = document.querySelector<HTMLElement>("#ball-marker")!;
const playerOverlayLayer = document.querySelector<HTMLElement>("#player-overlays")!;
const showProjectionOverlay = new URLSearchParams(location.search).has("overlay");

userInput.value =
  new URLSearchParams(location.search).get("user") ??
  `player-${Math.random().toString(36).slice(2, 6)}`;

let runtime: CanvasRuntime | undefined;
let joining = false;
let ballIds = new Set<string>();
let participantsByAvatar = new Map<string, Readonly<ParticipantPresence>>();
const playerLabels = new Map<string, HTMLElement>();
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
};

const renderPlayerOverlays = (snapshot: Readonly<OverlayProjectionSnapshot>): void => {
  const seen = new Set<string>();
  for (const avatar of snapshot.entities) {
    const participant = participantsByAvatar.get(avatar.entityId);
    if (!participant) continue;
    seen.add(avatar.entityId);
    let label = playerLabels.get(avatar.entityId);
    if (!label) {
      label = document.createElement("div");
      label.className = "player-label";
      const stars = document.createElement("span");
      stars.className = "player-stars";
      stars.textContent = "★".repeat(playerStarCount(participant.participantId));
      const name = document.createElement("span");
      name.className = "player-name";
      label.append(stars, name);
      playerOverlayLayer.appendChild(label);
      playerLabels.set(avatar.entityId, label);
    }
    const name = label.querySelector<HTMLElement>(".player-name")!;
    name.textContent = participant.displayName;
    label.dataset.status = participant.status;
    label.hidden = !avatar.visible || !avatar.inViewport;
    if (!label.hidden) {
      const labelY = avatar.screen.y - 4.2 * snapshot.viewport.scale;
      label.style.transform =
        `translate(${avatar.screen.x}px, ${labelY}px) translate(-50%, -100%)`;
    }
  }
  for (const [entityId, label] of playerLabels) {
    if (seen.has(entityId)) continue;
    label.remove();
    playerLabels.delete(entityId);
  }
};

const clearPlayerOverlays = (): void => {
  participantsByAvatar.clear();
  playerLabels.clear();
  playerOverlayLayer.replaceChildren();
};

const join = async (): Promise<void> => {
  if (runtime || joining) return;
  joining = true;
  joinButton.disabled = true;
  status.textContent = "Joining…";

  let nextRuntime: CanvasRuntime | undefined;
  try {
    const { CanvasRuntime, SimulationDriver, devRealtimeCredential } = await import(
      "@canvas-physics/client/runtime"
    );
    const worker = new Worker(new URL("./canvas.worker.ts", import.meta.url), {
      type: "module",
      name: "soccer-lounge-simulation",
    });
    nextRuntime = new CanvasRuntime({
      roomId: "soccer-lounge",
      serverUrl,
      credentialProvider: async () =>
        devRealtimeCredential(userInput.value, userInput.value),
      mount: stage,
      definitions: soccerDefinitions,
      assets: soccerAssets,
      driver: new SimulationDriver(worker),
      projectParticipantAvatar: projectSoccerParticipantAvatar,
      scene: {
        background: 0x165c31,
        debug: new URLSearchParams(location.search).has("debug"),
      },
      onAssetProgress: ({ loaded, total }) => {
        status.textContent = `Loading lounge art… ${loaded}/${total}`;
      },
      onAssetWarning: (warning) => {
        console.warn(`[soccer assets] ${warning.message}`, warning.cause);
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
        participantsByAvatar = new Map(
          snapshot.participants.map((participant) => [
            participant.avatarEntityId,
            participant,
          ]),
        );
        participantCount.textContent = String(
          snapshot.participants.filter(({ status }) => status !== "disconnected").length,
        );
      }),
      nextRuntime.subscribeEffects((effect) => {
        if (effect.effect !== "goal") return;
        scoreBoard.classList.remove("goal-flash");
        requestAnimationFrame(() => scoreBoard.classList.add("goal-flash"));
      }),
      nextRuntime.subscribeOverlayProjection(renderPlayerOverlays, {
        maxHz: 15,
        maxEntities: 64,
        kinds: ["avatar"],
      }),
      ...(showProjectionOverlay
        ? [nextRuntime.subscribeOverlayProjection((snapshot) => {
            const ball = snapshot.entities[0];
            ballMarker.hidden = !ball || !ball.visible || !ball.inViewport;
            if (!ball || ballMarker.hidden) return;
            ballMarker.style.transform =
              `translate(${ball.screen.x}px, ${ball.screen.y}px) translate(-50%, -145%)`;
          }, {
            maxHz: 10,
            maxEntities: 1,
            definitionIds: ["soccer-ball"],
          })]
        : []),
    ];
    await nextRuntime.start();
    await nextRuntime.whenReady();
    leaveButton.disabled = false;
    benchButton.disabled = false;
  } catch (error) {
    runtime = undefined;
    nextRuntime?.stop();
    unsubscribers.forEach((unsubscribe) => unsubscribe());
    unsubscribers = [];
    joinButton.disabled = false;
    status.textContent = `Join failed: ${String(error)}`;
  } finally {
    joining = false;
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
  benchButton.disabled = true;
  status.textContent = "Not connected";
  participantCount.textContent = "0";
  clearPlayerOverlays();
  ballMarker.hidden = true;
};

joinButton.addEventListener("click", () => void join());
leaveButton.addEventListener("click", leave);
benchButton.addEventListener("click", () => runtime?.toggleAvatarDisabled());

if (new URLSearchParams(location.search).has("autojoin")) void join();
