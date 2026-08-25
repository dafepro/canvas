import type { CanvasRuntime } from "@canvas-physics/client/runtime";
import { basketballAssets } from "./assets.js";
import {
  defaultBasketballConfig,
  type BasketballState,
} from "./basketball-behavior.js";
import { basketballDefinitions } from "./basketball-content.js";
import "./style.css";

const params = new URLSearchParams(location.search);
const serverUrl =
  import.meta.env.VITE_SERVER_URL ?? `${location.protocol}//${location.hostname}:8085`;

const stage = document.querySelector<HTMLElement>("#stage")!;
const gameShell = document.querySelector<HTMLElement>("main")!;
const userInput = document.querySelector<HTMLInputElement>("#user")!;
const joinButton = document.querySelector<HTMLButtonElement>("#join")!;
const leaveButton = document.querySelector<HTMLButtonElement>("#leave")!;
const fullscreenButton = document.querySelector<HTMLButtonElement>("#fullscreen")!;
const status = document.querySelector<HTMLElement>("#status")!;
const participantCount = document.querySelector<HTMLElement>("#participant-count")!;
const tealScoreboard = document.querySelector<HTMLElement>("#teal-scoreboard")!;
const coralScoreboard = document.querySelector<HTMLElement>("#coral-scoreboard")!;
const scoreboards = [tealScoreboard, coralScoreboard] as const;
const scoreboardOverlays = new Map([
  ["teal-scoreboard", tealScoreboard],
  ["coral-scoreboard", coralScoreboard],
]);
const tealScore = document.querySelector<HTMLElement>("#teal-score")!;
const coralScore = document.querySelector<HTMLElement>("#coral-score")!;
const gameMessage = document.querySelector<HTMLElement>("#game-message")!;
const pointsPerBasket = document.querySelector<HTMLElement>("#points-per-basket")!;
const basketResetSeconds = document.querySelector<HTMLElement>("#basket-reset-seconds")!;
const gameResetSeconds = document.querySelector<HTMLElement>("#game-reset-seconds")!;
const winningScore = document.querySelector<HTMLElement>("#winning-score")!;

const rulesMessage =
  `First to ${defaultBasketballConfig.winningScore} · baskets score ${defaultBasketballConfig.pointsPerBasket}`;

gameMessage.textContent = rulesMessage;
pointsPerBasket.textContent = String(defaultBasketballConfig.pointsPerBasket);
basketResetSeconds.textContent = String(defaultBasketballConfig.basketResetSeconds);
gameResetSeconds.textContent = String(defaultBasketballConfig.gameResetSeconds);
winningScore.textContent = String(defaultBasketballConfig.winningScore);

userInput.value =
  params.get("user") ?? `baller-${Math.random().toString(36).slice(2, 6)}`;

let runtime: CanvasRuntime | undefined;
let joining = false;
let unsubscribers: (() => void)[] = [];
const presentationTimeoutMs = 12_000;

const waitForPresentation = async (next: CanvasRuntime): Promise<void> => {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      next.whenPresented(),
      new Promise<never>((_, reject) => {
        timeout = setTimeout(
          () => reject(new Error("arena did not receive its initial room state")),
          presentationTimeoutMs,
        );
      }),
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
};

const renderScore = (state: Readonly<BasketballState>): void => {
  tealScore.textContent = String(state.tealScore);
  coralScore.textContent = String(state.coralScore);
  for (const board of scoreboards) {
    board.dataset.phase = state.phase;
    board.dataset.team = state.lastScoringTeam ?? "";
  }

  if (state.phase === "gameOver") {
    gameMessage.textContent =
      `${state.winner === "teal" ? "Teal" : "Coral"} wins · new game in ${defaultBasketballConfig.gameResetSeconds} seconds`;
  } else if (state.phase === "basket") {
    gameMessage.textContent =
      `${state.lastScoringTeam === "teal" ? "Teal" : "Coral"} +${defaultBasketballConfig.pointsPerBasket} · resetting possession`;
  } else {
    gameMessage.textContent = rulesMessage;
  }
};

const join = async (): Promise<void> => {
  if (runtime || joining) return;
  joining = true;
  joinButton.disabled = true;
  status.textContent = "Joining arena…";

  let next: CanvasRuntime | undefined;
  try {
    const { CanvasRuntime, SimulationDriver, devRealtimeCredential } = await import(
      "@canvas-physics/client/runtime"
    );
    const worker = new Worker(new URL("./canvas.worker.ts", import.meta.url), {
      type: "module",
      name: "basketball-arena-simulation",
    });
    next = new CanvasRuntime({
      roomId: "basketball-arena-v2",
      serverUrl,
      credentialProvider: async () =>
        devRealtimeCredential(userInput.value, userInput.value),
      mount: stage,
      fullscreenElement: gameShell,
      definitions: basketballDefinitions,
      assets: basketballAssets,
      driver: new SimulationDriver(worker),
      scene: {
        background: 0x071a32,
        debug: params.has("debug"),
        motionTrails: [{
          effect: "avatarFireTrail",
          kinds: ["avatar"],
          minSpeed: 2.5,
          fullSpeed: 19,
          emissionRate: { min: 10, max: 105 },
          colors: [0xffe45e, 0xffa31a, 0xff4b13, 0xe51b12],
          sizePx: { min: 2.4, max: 8.5 },
          lifeMs: { min: 220, max: 620 },
        }],
      },
      pointer: {
        mode: "avatarDrag",
        grabRadiusPx: 38,
        deadZonePx: 4,
        fullRangePx: 58,
        flick: {
          sampleWindowMs: 100,
          minimumSpeedPxPerSecond: 300,
          fullSpeedPxPerSecond: 1_300,
        },
      },
      onAssetProgress: ({ loaded, total }) => {
        status.textContent = loaded === total
          ? "Arena art ready · connecting…"
          : `Loading arena art… ${loaded}/${total}`;
      },
      onAssetWarning: (warning) => {
        console.warn(`[basketball assets] ${warning.message}`, warning.cause);
      },
      onDiagnostics: ({ isHost, tick }) => {
        status.textContent = `${isHost ? "Simulation host" : "Peer"} · tick ${tick}`;
      },
      onError: (error) => {
        status.textContent = `Arena error · ${error.code}: ${error.message}`;
      },
    });
    runtime = next;
    unsubscribers = [
      next.subscribeLifecycle(({ state }) => {
        if (state === "starting") {
          status.textContent = "Arena art ready · connecting…";
        } else if (state === "joining") {
          status.textContent = "Connected · syncing arena…";
        } else if (state === "reconnecting") {
          status.textContent = "Connection interrupted · retrying…";
        }
      }),
      next.subscribeBehaviorState((snapshot) => {
        const game = snapshot.states.find(
          ({ entityId }) => entityId === "basketball-game-ball",
        );
        if (game) renderScore(game.state as BasketballState);
      }),
      next.subscribeOverlayProjection((snapshot) => {
        for (const entity of snapshot.entities) {
          const overlay = scoreboardOverlays.get(entity.entityId);
          if (!overlay) continue;
          overlay.style.left = `${entity.screen.x}px`;
          overlay.style.top = `${entity.screen.y}px`;
          overlay.dataset.ready = String(entity.visible && entity.inViewport);
        }
      }, {
        maxHz: 60,
        maxEntities: 2,
        entityIds: ["teal-scoreboard", "coral-scoreboard"],
      }),
      next.subscribePresence((snapshot) => {
        participantCount.textContent = String(
          snapshot.participants.filter(({ status: state }) => state !== "disconnected").length,
        );
      }),
      next.subscribeEffects((effect) => {
        if (effect.effect !== "basketScored" && effect.effect !== "gameReset") return;
        for (const board of scoreboards) board.classList.remove("score-flash", "reset-flash");
        requestAnimationFrame(() => {
          for (const board of scoreboards) {
            board.classList.add(
              effect.effect === "gameReset" ? "reset-flash" : "score-flash",
            );
          }
        });
      }),
      next.subscribeFullscreen((active) => {
        fullscreenButton.textContent = active ? "Exit full screen" : "Full screen";
        fullscreenButton.setAttribute("aria-pressed", String(active));
      }),
    ];
    await next.start();
    await waitForPresentation(next);
    leaveButton.disabled = false;
    fullscreenButton.disabled = false;
  } catch (error) {
    runtime = undefined;
    next?.stop();
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
    stage.replaceChildren();
    joinButton.disabled = false;
  });
  leaveButton.disabled = true;
  fullscreenButton.disabled = true;
  participantCount.textContent = "0";
  status.textContent = "Not connected";
};

joinButton.addEventListener("click", () => void join());
leaveButton.addEventListener("click", leave);
fullscreenButton.addEventListener("click", () => {
  const current = runtime;
  if (!current) return;
  void current.toggleFullscreen().catch((error) => {
    status.textContent = `Full screen unavailable: ${String(error)}`;
  });
});

if (params.has("autojoin")) void join();
