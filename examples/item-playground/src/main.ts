import type {
  CanvasRuntime,
  CanonicalStateSnapshot,
  OverlayProjectionSnapshot,
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
const spawnToggle = document.querySelector<HTMLButtonElement>("#spawn-toggle")!;
const manageToggle = document.querySelector<HTMLButtonElement>("#manage-toggle")!;
const spawnPopover = document.querySelector<HTMLElement>("#spawn-popover")!;
const managePopover = document.querySelector<HTMLElement>("#manage-popover")!;
const ownedList = document.querySelector<HTMLElement>("#owned-list")!;
const ownershipLayer = document.querySelector<HTMLElement>("#ownership-layer")!;
const editToolbar = document.querySelector<HTMLElement>("#edit-toolbar")!;
const colorTools = document.querySelector<HTMLElement>("#color-tools")!;
const moreToggle = document.querySelector<HTMLButtonElement>("#more-toggle")!;
const moreMenu = document.querySelector<HTMLElement>("#more-menu")!;
const finishEdit = document.querySelector<HTMLButtonElement>("#finish-edit")!;
const connectionStatus = document.querySelector<HTMLElement>("#connection-status")!;
const actionStatus = document.querySelector<HTMLElement>("#action-status")!;
const rotateLeft = document.querySelector<HTMLButtonElement>("#rotate-left")!;
const rotateRight = document.querySelector<HTMLButtonElement>("#rotate-right")!;
const scaleDown = document.querySelector<HTMLButtonElement>("#scale-down")!;
const scaleUp = document.querySelector<HTMLButtonElement>("#scale-up")!;
const isolateButton = document.querySelector<HTMLButtonElement>("#isolate")!;
const collisionsButton = document.querySelector<HTMLButtonElement>("#collisions")!;
const customColorPicker = document.querySelector<HTMLInputElement>("#custom-color-picker")!;
const customColorControl = document.querySelector<HTMLElement>(".custom-color")!;
const deleteButton = document.querySelector<HTMLButtonElement>("#delete")!;
const paletteButtons = [...document.querySelectorAll<HTMLButtonElement>("[data-spawn]")];
const highlightButtons = [
  ...document.querySelectorAll<HTMLButtonElement>("[data-highlight]"),
];

userInput.value = params.get("user") ?? `maker-${Math.random().toString(36).slice(2, 6)}`;

let runtime: CanvasRuntime | undefined;
let joining = false;
let unsubscribeState: (() => void) | undefined;
let unsubscribeOverlay: (() => void) | undefined;
let entities: readonly Readonly<RenderEntity>[] = [];
let selectedEntityId: string | undefined;
let pendingAfterRevision: number | undefined;
let spawnCursor = 0;
let idsBeforeSpawn = new Set<string>();
let pendingSpawnDefinition: string | undefined;
let lastManageSignature = "";
stage.dataset.ownedStyle = "aurora";

const definitionById = new Map(
  playgroundDefinitions.map((definition) => [definition.definitionId, definition]),
);
const editableColors = new Set(["reactive-orb", "color-tile"]);
const spawnPositions = [
  { x: 7, y: 6 }, { x: 14, y: 6 }, { x: 22, y: 6 }, { x: 29, y: 6 },
  { x: 7, y: 14 }, { x: 14, y: 14 }, { x: 22, y: 14 }, { x: 29, y: 14 },
];

const selectedEntity = (): Readonly<RenderEntity> | undefined =>
  entities.find(({ id }) => id === selectedEntityId);

const isOwned = (entity: Readonly<RenderEntity>): boolean =>
  entity.kind === "item" && entity.ownerUserId === userInput.value;

const closePopovers = (except?: HTMLElement): void => {
  for (const [button, panel] of [
    [spawnToggle, spawnPopover],
    [manageToggle, managePopover],
  ] as const) {
    if (panel === except) continue;
    panel.hidden = true;
    button.setAttribute("aria-expanded", "false");
  }
};

const closeMoreMenu = (): void => {
  moreMenu.hidden = true;
  moreToggle.setAttribute("aria-expanded", "false");
};

const togglePopover = (button: HTMLButtonElement, panel: HTMLElement): void => {
  const open = panel.hidden;
  closePopovers(panel);
  panel.hidden = !open;
  button.setAttribute("aria-expanded", String(open));
};

const requestMutation = (message: string, action: () => void): void => {
  if (!runtime) return;
  pendingAfterRevision = runtime.diagnostics().sceneRevision;
  actionStatus.textContent = message;
  actionStatus.dataset.kind = "pending";
  action();
};

const renderOwnedList = (): void => {
  const owned = entities.filter(isOwned);
  const signature = owned
    .map(({ id, definitionId, isolated, collisionsDisabled }) =>
      `${id}:${definitionId}:${isolated}:${collisionsDisabled}`,
    )
    .join("|");
  if (signature === lastManageSignature) return;
  lastManageSignature = signature;
  if (owned.length === 0) {
    ownedList.innerHTML = '<p class="empty">Nothing spawned yet.</p>';
    return;
  }
  ownedList.replaceChildren(
    ...owned.map((entity) => {
      const button = document.createElement("button");
      button.className = "owned-row";
      button.classList.toggle("selected", entity.id === selectedEntityId);
      const definition = definitionById.get(entity.definitionId);
      button.innerHTML = `<span>${definition?.displayName ?? entity.definitionId}</span><small>${entity.isolated ? "paused" : "live"}</small>`;
      button.addEventListener("click", () => {
        selectedEntityId = entity.id;
        closeMoreMenu();
        closePopovers();
        lastManageSignature = "";
        renderOwnedList();
      });
      return button;
    }),
  );
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
    closeMoreMenu();
  }
  if (pendingAfterRevision !== undefined && snapshot.sceneRevision > pendingAfterRevision) {
    pendingAfterRevision = undefined;
    actionStatus.textContent = "Accepted · room updated";
    actionStatus.dataset.kind = "accepted";
  }
  renderOwnedList();
};

const ensureOutline = (entityId: string): HTMLElement => {
  let outline = ownershipLayer.querySelector<HTMLElement>(
    `[data-outline-id="${CSS.escape(entityId)}"]`,
  );
  if (!outline) {
    outline = document.createElement("div");
    outline.className = "owned-outline";
    outline.dataset.outlineId = entityId;
    ownershipLayer.append(outline);
  }
  return outline;
};

const renderOverlays = (snapshot: Readonly<OverlayProjectionSnapshot>): void => {
  const ownedIds = new Set(entities.filter(isOwned).map(({ id }) => id));
  ownershipLayer.querySelectorAll<HTMLElement>("[data-outline-id]").forEach((outline) => {
    if (!ownedIds.has(outline.dataset.outlineId!)) outline.remove();
  });

  for (const projection of snapshot.entities) {
    const entity = entities.find(({ id }) => id === projection.entityId);
    if (!entity || !isOwned(entity)) continue;
    const definition = definitionById.get(entity.definitionId);
    if (!definition) continue;
    const outline = ensureOutline(entity.id);
    const scale = (entity.scale ?? 1) * snapshot.viewport.scale;
    outline.style.width = `${definition.visual.size.width * scale}px`;
    outline.style.height = `${definition.visual.size.height * scale}px`;
    outline.style.left = `${projection.screen.x}px`;
    outline.style.top = `${projection.screen.y}px`;
    outline.style.transform = `translate(-50%, -50%) rotate(${projection.rotation}rad)`;
    outline.classList.toggle("selected", entity.id === selectedEntityId);
    outline.classList.toggle("isolated", entity.isolated === true);
    outline.classList.toggle("collisions-off", entity.collisionsDisabled === true);
    outline.hidden = !projection.visible;
  }

  const entity = selectedEntity();
  const projection = snapshot.entities.find(({ entityId }) => entityId === entity?.id);
  if (!entity || !projection || !isOwned(entity) || !projection.visible) {
    editToolbar.hidden = true;
    closeMoreMenu();
    return;
  }
  editToolbar.hidden = false;
  editToolbar.style.left = `${projection.screen.x}px`;
  const definition = definitionById.get(entity.definitionId);
  const visualScale = (entity.scale ?? 1) * snapshot.viewport.scale;
  editToolbar.style.top = `${projection.screen.y}px`;
  editToolbar.style.width = `${(definition?.visual.size.width ?? 3) * visualScale}px`;
  editToolbar.style.height = `${(definition?.visual.size.height ?? 3) * visualScale}px`;
  colorTools.hidden = !editableColors.has(entity.definitionId);
  isolateButton.classList.toggle("active", entity.isolated === true);
  isolateButton.querySelector("b")!.textContent = entity.isolated ? "▶" : "❄";
  isolateButton.querySelector("span")!.textContent = entity.isolated
    ? "Unfreeze object"
    : "Freeze object";
  isolateButton.setAttribute(
    "aria-label",
    entity.isolated ? "Unfreeze object" : "Freeze object",
  );
  isolateButton.title = entity.isolated
    ? "Resume motion, collision, behavior, and timers"
    : "Freeze motion, collision, behavior, and timers";
  collisionsButton.classList.toggle("active", entity.collisionsDisabled === true);
  collisionsButton.querySelector("b")!.textContent = entity.collisionsDisabled ? "○" : "◉";
  collisionsButton.querySelector("span")!.textContent = entity.collisionsDisabled
    ? "Enable collisions"
    : "Disable collisions";
  collisionsButton.setAttribute(
    "aria-label",
    entity.collisionsDisabled ? "Enable collisions" : "Disable collisions",
  );
  document.querySelectorAll<HTMLButtonElement>("[data-color]").forEach((button) => {
    button.classList.toggle("active", button.dataset.color === entity.variant);
  });
  customColorControl.classList.toggle("active", entity.variant === "custom");
  if (entity.variant === "custom" && entity.tint !== undefined) {
    customColorPicker.value = `#${entity.tint.toString(16).padStart(6, "0")}`;
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
      roomId: "item-playground-live",
      serverUrl,
      credentialProvider: async () =>
        devRealtimeCredential(userInput.value, userInput.value),
      mount: stage,
      definitions: playgroundDefinitions,
      assets: playgroundAssets,
      driver: new SimulationDriver(worker),
      scene: { background: 0xe8edf4, debug: params.has("debug") },
      pointer: { mode: "thumbstick", deadZonePx: 4, fullRangePx: 60 },
      onEditSelectionChange: ({ selectedEntityId: id }) => {
        selectedEntityId = id;
        closeMoreMenu();
        lastManageSignature = "";
        renderOwnedList();
      },
      onAssetProgress: ({ loaded, total }) => {
        connectionStatus.textContent = `Loading assets… ${loaded}/${total}`;
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
    unsubscribeState = nextRuntime.subscribeCanonicalState(observeState);
    unsubscribeOverlay = nextRuntime.subscribeOverlayProjection(renderOverlays, {
      maxHz: 60,
      kinds: ["item"],
    });
    await nextRuntime.start();
    await nextRuntime.whenReady();
    nextRuntime.setEditMode(true);
    leaveButton.disabled = false;
    spawnToggle.disabled = false;
    manageToggle.disabled = false;
    paletteButtons.forEach((button) => {
      button.disabled = false;
    });
    actionStatus.textContent = "Ready · editing is live";
  } catch (error) {
    runtime = undefined;
    nextRuntime?.stop();
    unsubscribeState?.();
    unsubscribeOverlay?.();
    unsubscribeState = undefined;
    unsubscribeOverlay = undefined;
    joinButton.disabled = false;
    connectionStatus.textContent = `Join failed: ${String(error)}`;
  } finally {
    joining = false;
  }
};

const leave = (): void => {
  const leaving = runtime;
  runtime = undefined;
  unsubscribeState?.();
  unsubscribeOverlay?.();
  unsubscribeState = undefined;
  unsubscribeOverlay = undefined;
  void (leaving?.stopGracefully() ?? Promise.resolve()).finally(() => {
    stage.querySelectorAll("canvas").forEach((canvas) => canvas.remove());
    joinButton.disabled = false;
  });
  leaveButton.disabled = true;
  spawnToggle.disabled = true;
  manageToggle.disabled = true;
  paletteButtons.forEach((button) => {
    button.disabled = true;
  });
  closePopovers();
  entities = [];
  selectedEntityId = undefined;
  closeMoreMenu();
  ownershipLayer.replaceChildren();
  editToolbar.hidden = true;
  lastManageSignature = "";
  connectionStatus.textContent = "Not connected";
  actionStatus.textContent = "Ready";
  renderOwnedList();
};

spawnToggle.addEventListener("click", (event) => {
  event.stopPropagation();
  togglePopover(spawnToggle, spawnPopover);
});
manageToggle.addEventListener("click", (event) => {
  event.stopPropagation();
  togglePopover(manageToggle, managePopover);
});
spawnPopover.addEventListener("click", (event) => event.stopPropagation());
managePopover.addEventListener("click", (event) => event.stopPropagation());
document.addEventListener("click", () => {
  closePopovers();
  closeMoreMenu();
});
document.addEventListener("keydown", (event) => {
  if (event.key === "Escape") {
    closePopovers();
    closeMoreMenu();
  }
});
moreToggle.addEventListener("click", (event) => {
  event.stopPropagation();
  const open = moreMenu.hidden;
  moreMenu.hidden = !open;
  moreToggle.setAttribute("aria-expanded", String(open));
});
moreMenu.addEventListener("click", (event) => event.stopPropagation());
highlightButtons.forEach((button) =>
  button.addEventListener("click", () => {
    const style = button.dataset.highlight!;
    stage.dataset.ownedStyle = style;
    highlightButtons.forEach((candidate) =>
      candidate.classList.toggle("active", candidate === button),
    );
  }),
);

paletteButtons.forEach((button) =>
  button.addEventListener("click", () => {
    const definitionId = button.dataset.spawn!;
    const position = spawnPositions[spawnCursor++ % spawnPositions.length]!;
    idsBeforeSpawn = new Set(entities.map(({ id }) => id));
    pendingSpawnDefinition = definitionId;
    closePopovers();
    requestMutation(
      `Spawning ${definitionById.get(definitionId)?.displayName ?? definitionId}…`,
      () => runtime!.spawnItem(definitionId, position),
    );
  }),
);

rotateLeft.addEventListener("click", () => {
  const entity = selectedEntity();
  if (!entity) return;
  requestMutation("Rotating…", () =>
    runtime!.rotateItem(entity.id, entity.rotation - Math.PI / 12),
  );
});
rotateRight.addEventListener("click", () => {
  const entity = selectedEntity();
  if (!entity) return;
  requestMutation("Rotating…", () =>
    runtime!.rotateItem(entity.id, entity.rotation + Math.PI / 12),
  );
});
scaleDown.addEventListener("click", () => {
  const entity = selectedEntity();
  if (!entity) return;
  requestMutation("Scaling…", () =>
    runtime!.scaleItem(entity.id, Math.max(0.5, (entity.scale ?? 1) - 0.15)),
  );
});
scaleUp.addEventListener("click", () => {
  const entity = selectedEntity();
  if (!entity) return;
  requestMutation("Scaling…", () =>
    runtime!.scaleItem(entity.id, Math.min(2.5, (entity.scale ?? 1) + 0.15)),
  );
});
isolateButton.addEventListener("click", () => {
  const entity = selectedEntity();
  if (!entity) return;
  const isolated = entity.isolated !== true;
  requestMutation(
    isolated
      ? "Freezing this object…"
      : "Unfreezing this object…",
    () => runtime!.setItemIsolation(entity.id, isolated),
  );
});
collisionsButton.addEventListener("click", () => {
  const entity = selectedEntity();
  if (!entity) return;
  const enabled = entity.collisionsDisabled === true;
  requestMutation(enabled ? "Enabling collisions…" : "Disabling collisions…", () =>
    runtime!.setItemCollisionsEnabled(entity.id, enabled),
  );
});
document.querySelectorAll<HTMLButtonElement>("[data-color]").forEach((button) =>
  button.addEventListener("click", () => {
    const entity = selectedEntity();
    if (!entity) return;
    const theme = button.dataset.color as OrbTheme;
    requestMutation(`Applying ${theme}…`, () =>
      runtime!.setItemConfig(entity.id, {
        theme,
        customColor: customColorPicker.value,
      }),
    );
  }),
);
customColorPicker.addEventListener("change", () => {
  const entity = selectedEntity();
  if (!entity) return;
  requestMutation(`Applying ${customColorPicker.value}…`, () =>
    runtime!.setItemConfig(entity.id, {
      theme: "custom",
      customColor: customColorPicker.value,
    }),
  );
});
deleteButton.addEventListener("click", () => {
  const entity = selectedEntity();
  if (!entity) return;
  requestMutation("Deleting…", () => runtime!.deleteItem(entity.id));
  runtime?.clearItemEditSelection();
  selectedEntityId = undefined;
  closeMoreMenu();
  editToolbar.hidden = true;
  lastManageSignature = "";
  renderOwnedList();
});
finishEdit.addEventListener("click", () => {
  const entity = selectedEntity();
  if (entity?.isolated) {
    requestMutation("Finished · returning item to live simulation…", () =>
      runtime!.setItemIsolation(entity.id, false),
    );
  } else {
    actionStatus.textContent = "Finished editing · item remains live";
    actionStatus.dataset.kind = "accepted";
  }
  runtime?.clearItemEditSelection();
  selectedEntityId = undefined;
  closeMoreMenu();
  editToolbar.hidden = true;
  lastManageSignature = "";
  renderOwnedList();
});
joinButton.addEventListener("click", () => void join());
leaveButton.addEventListener("click", leave);

renderOwnedList();
if (params.has("autojoin")) void join();
