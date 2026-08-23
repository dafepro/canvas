import type {
  CanvasRuntime,
  CanonicalStateSnapshot,
} from "@canvas-physics/client/runtime";
import type { RenderEntity } from "@canvas-physics/client";
import { playgroundAssets } from "./assets.js";
import { playgroundDefinitions } from "./content.js";
import type { OrbTheme } from "./reactive-orb-behavior.js";
import "./style.css";

const params = new URLSearchParams(location.search);
const serverUrl =
  import.meta.env.VITE_SERVER_URL ?? `${location.protocol}//${location.hostname}:8083`;
const stage = document.querySelector<HTMLElement>("#stage")!;
const userInput = document.querySelector<HTMLInputElement>("#user")!;
const joinButton = document.querySelector<HTMLButtonElement>("#join")!;
const leaveButton = document.querySelector<HTMLButtonElement>("#leave")!;
const modeButton = document.querySelector<HTMLButtonElement>("#mode")!;
const itemList = document.querySelector<HTMLElement>("#item-list")!;
const connectionStatus = document.querySelector<HTMLElement>("#connection-status")!;
const actionStatus = document.querySelector<HTMLElement>("#action-status")!;
const selectionName = document.querySelector<HTMLElement>("#selection-name")!;
const selectionId = document.querySelector<HTMLElement>("#selection-id")!;
const selectionOwner = document.querySelector<HTMLElement>("#selection-owner")!;
const rotateLeft = document.querySelector<HTMLButtonElement>("#rotate-left")!;
const rotateRight = document.querySelector<HTMLButtonElement>("#rotate-right")!;
const scaleInput = document.querySelector<HTMLInputElement>("#scale")!;
const scaleValue = document.querySelector<HTMLOutputElement>("#scale-value")!;
const themeControls = document.querySelector<HTMLFieldSetElement>("#theme-controls")!;
const deleteButton = document.querySelector<HTMLButtonElement>("#delete")!;

userInput.value =
  params.get("user") ?? `maker-${Math.random().toString(36).slice(2, 6)}`;

let runtime: CanvasRuntime | undefined;
let joining = false;
let unsubscribe: (() => void) | undefined;
let entities: readonly Readonly<RenderEntity>[] = [];
let selectedEntityId: string | undefined;
let pendingAfterRevision: number | undefined;
let spawnCursor = 0;
let idsBeforeSpawn = new Set<string>();
let pendingSpawnDefinition: string | undefined;
let lastUiSignature = "";
const paletteButtons = [...document.querySelectorAll<HTMLButtonElement>("[data-spawn]")];
paletteButtons.forEach((button) => { button.disabled = true; });

const definitionNames = new Map(
  playgroundDefinitions.map(({ definitionId, displayName }) => [definitionId, displayName]),
);
const spawnPositions = [
  { x: 7, y: 6 },
  { x: 14, y: 6 },
  { x: 22, y: 6 },
  { x: 29, y: 6 },
  { x: 7, y: 13 },
  { x: 14, y: 13 },
  { x: 22, y: 13 },
  { x: 29, y: 13 },
];

const selectedEntity = (): Readonly<RenderEntity> | undefined =>
  entities.find(({ id }) => id === selectedEntityId);

const ownerLabel = (entity: Readonly<RenderEntity>): string => {
  if (!entity.ownerUserId) return "room / system";
  if (entity.ownerUserId === userInput.value) return "you";
  return entity.ownerUserId;
};

const requestMutation = (message: string, action: () => void): void => {
  if (!runtime) return;
  pendingAfterRevision = runtime.diagnostics().sceneRevision;
  actionStatus.textContent = message;
  actionStatus.dataset.kind = "pending";
  action();
};

const renderInspector = (): void => {
  const entity = selectedEntity();
  const enabled = Boolean(entity && runtime);
  rotateLeft.disabled = !enabled;
  rotateRight.disabled = !enabled;
  scaleInput.disabled = !enabled;
  deleteButton.disabled = !enabled;
  themeControls.disabled = !enabled || entity?.definitionId !== "reactive-orb";

  if (!entity) {
    selectionName.textContent = "Select an item";
    selectionId.textContent = "—";
    selectionOwner.textContent = "nothing selected";
    scaleInput.value = "1";
    scaleValue.value = "1.00×";
    return;
  }

  selectionName.textContent = definitionNames.get(entity.definitionId) ?? entity.definitionId;
  selectionId.textContent = entity.id;
  selectionOwner.textContent = `owned by ${ownerLabel(entity)}`;
  const scale = entity.scale ?? 1;
  scaleInput.value = String(scale);
  scaleValue.value = `${scale.toFixed(2)}×`;
  document.querySelectorAll<HTMLButtonElement>("[data-theme]").forEach((button) => {
    button.classList.toggle("active", button.dataset.theme === entity.variant);
  });
};

const renderList = (): void => {
  const items = entities.filter(({ kind }) => kind === "item");
  if (items.length === 0) {
    itemList.innerHTML = '<p class="empty">No items yet. Spawn one above.</p>';
    renderInspector();
    return;
  }
  itemList.replaceChildren(
    ...items.map((entity) => {
      const button = document.createElement("button");
      button.className = "item-row";
      button.classList.toggle("selected", entity.id === selectedEntityId);
      button.dataset.entityId = entity.id;
      const owned = ownerLabel(entity);
      button.innerHTML =
        `<span><b>${definitionNames.get(entity.definitionId) ?? entity.definitionId}</b>` +
        `<small>${entity.id}</small></span><em>${owned}</em>`;
      button.addEventListener("click", () => {
        selectedEntityId = entity.id;
        renderList();
      });
      return button;
    }),
  );
  renderInspector();
};

const observeState = (snapshot: CanonicalStateSnapshot): void => {
  entities = snapshot.entities;
  if (pendingSpawnDefinition) {
    const spawned = entities.find(
      (entity) =>
        entity.kind === "item" &&
        entity.definitionId === pendingSpawnDefinition &&
        entity.ownerUserId === userInput.value &&
        !idsBeforeSpawn.has(entity.id),
    );
    if (spawned) {
      selectedEntityId = spawned.id;
      pendingSpawnDefinition = undefined;
    }
  }
  if (selectedEntityId && !entities.some(({ id }) => id === selectedEntityId)) {
    selectedEntityId = undefined;
  }
  if (pendingAfterRevision !== undefined && snapshot.sceneRevision > pendingAfterRevision) {
    pendingAfterRevision = undefined;
    actionStatus.textContent = "Accepted · authoritative scene updated";
    actionStatus.dataset.kind = "accepted";
  }
  const itemSignature = entities
    .filter(({ kind }) => kind === "item")
    .map(({ id, ownerUserId, definitionId, rotation, scale, variant }) =>
      [id, ownerUserId, definitionId, rotation, scale, variant].join(":"),
    )
    .join("|");
  const uiSignature = `${snapshot.sceneRevision}/${selectedEntityId ?? ""}/${itemSignature}`;
  if (uiSignature !== lastUiSignature) {
    lastUiSignature = uiSignature;
    renderList();
  }
};

const join = async (): Promise<void> => {
  if (runtime || joining) return;
  joining = true;
  joinButton.disabled = true;
  connectionStatus.textContent = "Joining…";
  let nextRuntime: CanvasRuntime | undefined;
  try {
    const { CanvasRuntime, SimulationDriver, devRealtimeCredential } = await import(
      "@canvas-physics/client/runtime"
    );
    const worker = new Worker(new URL("./canvas.worker.ts", import.meta.url), {
      type: "module",
      name: "item-playground-simulation",
    });
    nextRuntime = new CanvasRuntime({
      roomId: "item-playground",
      serverUrl,
      credentialProvider: async () => devRealtimeCredential(userInput.value, userInput.value),
      mount: stage,
      definitions: playgroundDefinitions,
      assets: playgroundAssets,
      driver: new SimulationDriver(worker),
      scene: { background: 0xe8edf4, debug: params.has("debug") },
      pointer: { mode: "thumbstick", deadZonePx: 4, fullRangePx: 60 },
      onEditSelectionChange: ({ selectedEntityId: id }) => {
        selectedEntityId = id;
        renderList();
      },
      onAssetProgress: ({ loaded, total }) => {
        connectionStatus.textContent = `Loading consumer assets… ${loaded}/${total}`;
      },
      onError: (error) => {
        pendingAfterRevision = undefined;
        actionStatus.textContent = `Rejected · ${error.message.replaceAll("_", " ")}`;
        actionStatus.dataset.kind = "rejected";
      },
      onDiagnostics: ({ isHost, tick }) => {
        connectionStatus.textContent = `${isHost ? "Host" : "Peer"} · tick ${tick}`;
      },
    });
    runtime = nextRuntime;
    unsubscribe = nextRuntime.subscribeCanonicalState(observeState);
    await nextRuntime.start();
    await nextRuntime.whenReady();
    nextRuntime.setEditMode(true);
    leaveButton.disabled = false;
    modeButton.disabled = false;
    paletteButtons.forEach((button) => { button.disabled = false; });
    actionStatus.textContent = "Ready · spawn or select an item";
  } catch (error) {
    runtime = undefined;
    nextRuntime?.stop();
    unsubscribe?.();
    unsubscribe = undefined;
    joinButton.disabled = false;
    connectionStatus.textContent = `Join failed: ${String(error)}`;
  } finally {
    joining = false;
  }
};

const leave = (): void => {
  const leaving = runtime;
  runtime = undefined;
  unsubscribe?.();
  unsubscribe = undefined;
  void (leaving?.stopGracefully() ?? Promise.resolve()).finally(() => {
    stage.querySelectorAll("canvas").forEach((canvas) => canvas.remove());
    joinButton.disabled = false;
  });
  leaveButton.disabled = true;
  modeButton.disabled = true;
  modeButton.textContent = "Edit mode";
  modeButton.classList.remove("active");
  paletteButtons.forEach((button) => { button.disabled = true; });
  entities = [];
  selectedEntityId = undefined;
  lastUiSignature = "";
  connectionStatus.textContent = "Not connected";
  actionStatus.textContent = "Ready";
  renderList();
};

paletteButtons.forEach((button) => {
  button.addEventListener("click", () => {
    const definitionId = button.dataset.spawn!;
    const position = spawnPositions[spawnCursor++ % spawnPositions.length]!;
    idsBeforeSpawn = new Set(entities.map(({ id }) => id));
    pendingSpawnDefinition = definitionId;
    requestMutation(`Spawning ${definitionNames.get(definitionId)}…`, () =>
      runtime!.spawnItem(definitionId, position),
    );
  });
});

rotateLeft.addEventListener("click", () => {
  const entity = selectedEntity();
  if (!entity) return;
  requestMutation("Rotating item…", () =>
    runtime!.rotateItem(entity.id, entity.rotation - Math.PI / 12),
  );
});
rotateRight.addEventListener("click", () => {
  const entity = selectedEntity();
  if (!entity) return;
  requestMutation("Rotating item…", () =>
    runtime!.rotateItem(entity.id, entity.rotation + Math.PI / 12),
  );
});
scaleInput.addEventListener("input", () => {
  scaleValue.value = `${Number(scaleInput.value).toFixed(2)}×`;
});
scaleInput.addEventListener("change", () => {
  const entity = selectedEntity();
  if (!entity) return;
  requestMutation("Scaling visual and collider…", () =>
    runtime!.scaleItem(entity.id, Number(scaleInput.value)),
  );
});
document.querySelectorAll<HTMLButtonElement>("[data-theme]").forEach((button) => {
  button.addEventListener("click", () => {
    const entity = selectedEntity();
    if (!entity) return;
    const theme = button.dataset.theme as OrbTheme;
    requestMutation(`Applying ${theme} config…`, () =>
      runtime!.setItemConfig(entity.id, { theme }),
    );
  });
});
deleteButton.addEventListener("click", () => {
  const entity = selectedEntity();
  if (!entity) return;
  requestMutation("Deleting item…", () => runtime!.deleteItem(entity.id));
});
joinButton.addEventListener("click", () => void join());
leaveButton.addEventListener("click", leave);
modeButton.addEventListener("click", () => {
  const editing = runtime?.toggleEditMode() ?? false;
  modeButton.textContent = editing ? "Edit mode" : "Play mode";
  modeButton.classList.toggle("active", !editing);
  actionStatus.textContent = editing
    ? "Edit mode · drag owned items"
    : "Play mode · move the visitor and touch the orb";
});

renderList();
if (params.has("autojoin")) void join();
