import {
  CanvasRuntime,
  devRealtimeCredential,
  rocketCanvasDefinitions,
  type RuntimeDiagnostics,
} from "@canvas-physics/client";

const serverUrl =
  import.meta.env.VITE_SERVER_URL ?? `${location.protocol}//${location.hostname}:8080`;

const stage = document.querySelector<HTMLElement>("#stage")!;
const userInput = document.querySelector<HTMLInputElement>("#user")!;
const joinButton = document.querySelector<HTMLButtonElement>("#join")!;
const leaveButton = document.querySelector<HTMLButtonElement>("#leave")!;
const diagnosticsTable = document.querySelector<HTMLTableElement>("#diagnostics")!;
const disableButton = document.querySelector<HTMLButtonElement>("#disable-avatar")!;
const editButton = document.querySelector<HTMLButtonElement>("#edit-mode")!;

userInput.value =
  new URLSearchParams(location.search).get("user") ??
  `player-${Math.random().toString(36).slice(2, 6)}`;

let runtime: CanvasRuntime | undefined;

const renderDiagnostics = (diagnostics: RuntimeDiagnostics): void => {
  const rows: [string, string][] = [
    ["role", diagnostics.isHost ? "simulation host" : "peer"],
    ["client", diagnostics.clientId || "-"],
    ["host epoch", String(diagnostics.hostEpoch)],
    ["peers", String(diagnostics.peers)],
    ["tick", String(diagnostics.tick)],
    ["sim Hz", diagnostics.simulationHz.toFixed(1)],
    ["worker drift", `${diagnostics.driftMs.toFixed(1)} ms`],
    ["worst step", `${diagnostics.worstStepMs.toFixed(2)} ms`],
    ["awake bodies", String(diagnostics.awakeBodies)],
    ["colliders", String(diagnostics.activeColliders)],
    ["render FPS", diagnostics.renderFps.toFixed(0)],
    ["render p95", `${diagnostics.renderP95Ms.toFixed(2)} ms`],
    ["render worst", `${diagnostics.renderWorstMs.toFixed(2)} ms`],
    ["long frames", String(diagnostics.renderLongFrames)],
    ["background resumes", String(diagnostics.backgroundResumes)],
    ["last background", `${diagnostics.lastBackgroundMs.toFixed(0)} ms`],
    ["interp depth", String(diagnostics.interpolationDepth)],
    ["extrapolations", String(diagnostics.extrapolations)],
    ["reconcile error", diagnostics.reconcileError.toFixed(3)],
    ["scene revision", String(diagnostics.sceneRevision)],
    ["items", String(diagnostics.itemCount)],
    ["in", `${(diagnostics.inboundBytesPerSecond / 1024).toFixed(1)} KB/s`],
    ["out", `${(diagnostics.outboundBytesPerSecond / 1024).toFixed(1)} KB/s`],
    ["dropped out", String(diagnostics.droppedOutbound)],
    ["host migrations", String(diagnostics.hostMigrations)],
    ["quarantined", String(diagnostics.quarantined)],
  ];
  if (diagnostics.lastRejection) rows.push(["last reject", diagnostics.lastRejection]);

  diagnosticsTable.innerHTML = rows
    .map(
      ([key, value]) =>
        `<tr><td>${key}</td><td class="${
          key === "role" && diagnostics.isHost ? "host-badge" : ""
        }">${value}</td></tr>`,
    )
    .join("");
};

// Throttle the diagnostics repaint so it does not compete with rendering.
let lastPaintMs = 0;

const join = async (): Promise<void> => {
  if (runtime) return;
  joinButton.disabled = true;
  runtime = new CanvasRuntime({
    roomId: "rocket-canvas",
    serverUrl,
    credentialProvider: async () =>
      devRealtimeCredential(userInput.value, userInput.value),
    mount: stage,
    definitions: rocketCanvasDefinitions,
    scene: { debug: new URLSearchParams(location.search).has("debug") },
    onAvatarDisabledChange: (disabled) => {
      disableButton.textContent = disabled ? "Enable my avatar" : "Disable my avatar";
    },
    onEditModeChange: (enabled) => {
      editButton.textContent = enabled ? "Finish editing" : "Edit my items";
      editButton.classList.toggle("active", enabled);
    },
    onDiagnostics: (diagnostics) => {
      const now = performance.now();
      if (now - lastPaintMs < 250) return;
      lastPaintMs = now;
      renderDiagnostics(diagnostics);
    },
  });
  try {
    await runtime.start({ until: "presented" });
    leaveButton.disabled = false;
    disableButton.disabled = false;
    editButton.disabled = false;
  } catch (error) {
    joinButton.disabled = false;
    runtime = undefined;
    diagnosticsTable.innerHTML = `<tr><td>error</td><td>${String(error)}</td></tr>`;
  }
};

const leave = (): void => {
  const leaving = runtime;
  runtime = undefined;
  joinButton.disabled = true;
  void (leaving?.stopGracefully() ?? Promise.resolve()).finally(() => {
    stage.innerHTML = "";
    joinButton.disabled = false;
  });
  leaveButton.disabled = true;
  disableButton.disabled = true;
  disableButton.textContent = "Disable my avatar";
  editButton.disabled = true;
  editButton.textContent = "Edit my items";
  editButton.classList.remove("active");
};

disableButton.addEventListener("click", () => {
  runtime?.toggleAvatarDisabled();
});

editButton.addEventListener("click", () => {
  runtime?.toggleEditMode();
});

joinButton.addEventListener("click", () => void join());
leaveButton.addEventListener("click", leave);

for (const button of document.querySelectorAll<HTMLButtonElement>("[data-spawn]")) {
  button.addEventListener("click", () => {
    const definitionId = button.dataset.spawn!;
    // Spawn near the launch pad for the rocket, mid-canvas for the rest.
    const at = definitionId === "rocket" ? { x: 70, y: 62 } : { x: 40 + Math.random() * 20, y: 30 };
    runtime?.spawnItem(definitionId, at);
  });
}

if (new URLSearchParams(location.search).has("autojoin")) void join();
