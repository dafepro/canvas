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
const userInput = document.querySelector<HTMLInputElement>("#user")!;
const joinButton = document.querySelector<HTMLButtonElement>("#join")!;
const leaveButton = document.querySelector<HTMLButtonElement>("#leave")!;
const status = document.querySelector<HTMLElement>("#status")!;
const participantCount = document.querySelector<HTMLElement>("#participant-count")!;
const scoreboard = document.querySelector<HTMLElement>("#scoreboard")!;
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

const renderScore = (state: Readonly<BasketballState>): void => {
  tealScore.textContent = String(state.tealScore);
  coralScore.textContent = String(state.coralScore);
  scoreboard.dataset.phase = state.phase;
  scoreboard.dataset.team = state.lastScoringTeam ?? "";

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
      roomId: "basketball-arena",
      serverUrl,
      credentialProvider: async () =>
        devRealtimeCredential(userInput.value, userInput.value),
      mount: stage,
      definitions: basketballDefinitions,
      assets: basketballAssets,
      driver: new SimulationDriver(worker),
      scene: {
        background: 0x071a32,
        debug: params.has("debug"),
      },
      pointer: { mode: "thumbstick", deadZonePx: 4, fullRangePx: 58 },
      onAssetProgress: ({ loaded, total }) => {
        status.textContent = `Loading arena art… ${loaded}/${total}`;
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
      next.subscribeBehaviorState((snapshot) => {
        const game = snapshot.states.find(
          ({ entityId }) => entityId === "basketball-game-ball",
        );
        if (game) renderScore(game.state as BasketballState);
      }),
      next.subscribePresence((snapshot) => {
        participantCount.textContent = String(
          snapshot.participants.filter(({ status: state }) => state !== "disconnected").length,
        );
      }),
      next.subscribeEffects((effect) => {
        if (effect.effect !== "basketScored" && effect.effect !== "gameReset") return;
        scoreboard.classList.remove("score-flash", "reset-flash");
        requestAnimationFrame(() => {
          scoreboard.classList.add(
            effect.effect === "gameReset" ? "reset-flash" : "score-flash",
          );
        });
      }),
    ];
    await next.start();
    await next.whenPresented();
    leaveButton.disabled = false;
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
  participantCount.textContent = "0";
  status.textContent = "Not connected";
};

joinButton.addEventListener("click", () => void join());
leaveButton.addEventListener("click", leave);

if (params.has("autojoin")) void join();
