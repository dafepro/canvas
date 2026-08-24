import { RoomLinkGraph } from "@canvas-physics/core";
import type {
  CanvasRuntime,
  LinkedRoomHandle,
  LinkedRoomNavigator,
  RoomOpenRequest,
} from "@canvas-physics/client/runtime";
import { linkedRoomAssets } from "./assets.js";
import { linkedRoomDefinitions, linkedRoomLinks } from "./content.js";
import {
  linkedRoomFromSearch,
  urlForLinkedRoom,
  type LinkedRoomId,
} from "./route-state.js";
import "./style.css";

const userInput = document.querySelector<HTMLInputElement>("#user")!;
const joinButton = document.querySelector<HTMLButtonElement>("#join")!;
const leaveButton = document.querySelector<HTMLButtonElement>("#leave")!;
const backButton = document.querySelector<HTMLButtonElement>("#back")!;
const stage = document.querySelector<HTMLElement>("#stage")!;
const roomName = document.querySelector<HTMLElement>("#room-name")!;
const status = document.querySelector<HTMLElement>("#status")!;

const params = new URLSearchParams(location.search);
const initialRoom = linkedRoomFromSearch(location.search);
userInput.value = params.get("user") ?? `traveler-${Math.floor(Math.random() * 900 + 100)}`;
const serverUrl = import.meta.env.VITE_SERVER_URL || location.origin;
const names: Record<string, string> = {
  "linked-village": "Sunmeadow Village",
  "linked-cave": "Moonlit Cave",
};

let navigator: LinkedRoomNavigator | undefined;
let joining = false;

const join = async (): Promise<void> => {
  if (navigator || joining) return;
  joining = true;
  joinButton.disabled = true;
  status.textContent = "Loading Canvas and validating return routes…";
  try {
    const {
      CanvasRuntime,
      LinkedRoomNavigator,
      SimulationDriver,
      devRealtimeCredential,
    } = await import("@canvas-physics/client/runtime");
    const graph = new RoomLinkGraph(linkedRoomLinks);
    const openRoom = async (request: Readonly<RoomOpenRequest>): Promise<LinkedRoomHandle> => {
      const mount = document.createElement("div");
      mount.className = "room-stage staged";
      stage.append(mount);
      const worker = new Worker(new URL("./canvas.worker.ts", import.meta.url), {
        type: "module",
        name: `linked-room-${request.roomId}`,
      });
      const runtime: CanvasRuntime = new CanvasRuntime({
        roomId: request.roomId,
        serverUrl,
        credentialProvider: async () =>
          devRealtimeCredential(userInput.value, userInput.value),
        mount,
        definitions: linkedRoomDefinitions,
        assets: linkedRoomAssets,
        driver: new SimulationDriver(worker),
        scene: { background: request.roomId === "linked-cave" ? 0x111629 : 0xbde7b2 },
        pointer: { mode: "thumbstick", deadZonePx: 4, fullRangePx: 55 },
        spawnPointId: request.arrivalSpawnPointId ??
          (request.roomId === "linked-village" ? "village-square" : "cave-depths"),
        onAssetProgress: ({ loaded, total }) => {
          status.textContent = `Preparing ${names[request.roomId] ?? request.roomId} · assets ${loaded}/${total}`;
        },
        onDiagnostics: ({ isHost, tick }) => {
          if (!mount.classList.contains("staged")) {
            status.textContent = `${isHost ? "Host" : "Peer"} · tick ${tick} · walk into the glowing door`;
          }
        },
        onError: (error) => {
          if (!mount.classList.contains("staged")) {
            status.textContent = error.details?.serverCode === "session_superseded"
              ? "This participant is now open in a newer tab in this room. Use a unique name per tab."
              : `Room error · ${error.code}: ${error.message}`;
          }
        },
      });
      try {
        await runtime.start();
        await runtime.whenReady();
        await runtime.whenPresented();
      } catch (error) {
        runtime.stop();
        mount.remove();
        throw error;
      }

      return {
        roomId: request.roomId,
        avatarEntityId: runtime.session.avatarId,
        subscribeEffects: (observer) => runtime.subscribeEffects(observer),
        activate: () => {
          for (const other of stage.querySelectorAll(".room-stage")) {
            other.classList.add("staged");
          }
          mount.classList.remove("staged");
        },
        close: async () => {
          await runtime.stopGracefully();
          mount.remove();
        },
      };
    };

    navigator = new LinkedRoomNavigator({
      graph,
      openRoom,
      onChanged: (current, previous) => {
        roomName.textContent = names[current] ?? current;
        backButton.disabled = !navigator?.canGoBack;
        history.replaceState(
          history.state,
          "",
          urlForLinkedRoom(location.href, current as LinkedRoomId),
        );
        if (previous) status.textContent = `Arrived from ${names[previous] ?? previous}`;
      },
      onError: (error) => {
        status.textContent = `Travel cancelled · ${error.message}. You remain in this room.`;
      },
    });
    await navigator.start(initialRoom);
    leaveButton.disabled = false;
    backButton.disabled = !navigator.canGoBack;
  } catch (error) {
    status.textContent = `Join failed: ${String(error)}`;
    navigator = undefined;
    joinButton.disabled = false;
  } finally {
    joining = false;
  }
};

const leave = async (): Promise<void> => {
  const leaving = navigator;
  navigator = undefined;
  leaveButton.disabled = true;
  backButton.disabled = true;
  await leaving?.close();
  roomName.textContent = "Not connected";
  status.textContent = "Choose a name and join.";
  joinButton.disabled = false;
};

joinButton.addEventListener("click", () => void join());
leaveButton.addEventListener("click", () => void leave());
backButton.addEventListener("click", async () => {
  if (!navigator) return;
  backButton.disabled = true;
  status.textContent = "Taking the validated return route…";
  await navigator.back();
  backButton.disabled = !navigator.canGoBack;
});

if (params.has("autojoin")) void join();
