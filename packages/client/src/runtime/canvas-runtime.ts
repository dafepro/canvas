import {
  resolveItemConfig,
  type CanvasDefinition,
  type CanvasSnapshot,
  type ItemDefinition,
  type Transform,
} from "@canvas-physics/core";
import {
  DurableCommandKind,
  toJsonBytes,
  type DurableCommand,
  type EntityState,
} from "@canvas-physics/protocol";
import { AvatarReconciler } from "../net/avatar-reconciler.js";
import { RoomClient } from "../net/room-client.js";
import type { RoomTransport } from "../net/transport.js";
import { WebSocketRoomTransport } from "../net/websocket-transport.js";
import { PixiScene, type SceneOptions } from "../render/pixi-scene.js";
import { InterpolationBuffer } from "../render/interpolation-buffer.js";
import { KeyboardController } from "../input/keyboard-controller.js";
import { PointerDragController } from "../input/pointer-drag-controller.js";
import { SimulationDriver } from "../simulation/driver.js";
import type { RenderEntity, SimulationResponse } from "../simulation/messages.js";

export interface CanvasRuntimeOptions {
  canvasId: string;
  serverUrl: string;
  userId: string;
  displayName: string;
  mount: HTMLElement;
  /** Item definitions the client knows. Bundled for now (spec 26). */
  definitions: ItemDefinition[];
  transport?: RoomTransport;
  scene?: SceneOptions;
  /** Rates from spec 10.3. */
  rates?: {
    inputHz?: number;
    deltaHz?: number;
    keyframeHz?: number;
    checkpointHz?: number;
  };
  onDiagnostics?: (diagnostics: RuntimeDiagnostics) => void;
}

export interface RuntimeDiagnostics {
  status: string;
  isHost: boolean;
  hostEpoch: number;
  hostClientId: string;
  clientId: string;
  peers: number;
  tick: number;
  simulationHz: number;
  driftMs: number;
  worstStepMs: number;
  awakeBodies: number;
  renderFps: number;
  interpolationDepth: number;
  extrapolations: number;
  reconcileError: number;
  sceneRevision: number;
  itemCount: number;
  lastRejection?: string;
}

/**
 * The façade an application uses. It owns the transport, the simulation worker,
 * and the renderer, and it keeps the send rates from spec 10.3.
 */
export class CanvasRuntime {
  readonly client: RoomClient;
  private readonly driver = SimulationDriver.spawn();
  private readonly buffer = new InterpolationBuffer();
  private readonly reconciler = new AvatarReconciler();
  private scene?: PixiScene;
  private pointer?: PointerDragController;
  private keyboard?: KeyboardController;
  private canvas?: CanvasDefinition;
  private timers: ReturnType<typeof setInterval>[] = [];
  private localAvatarId = "";
  private inputSequence = 0;
  private hostEntities: RenderEntity[] = [];
  private localPrediction?: RenderEntity;
  private tick = 0;
  private stats = { hz: 0, driftMs: 0, worstStepMs: 0, awakeBodies: 0, behaviorErrors: 0 };
  private renderFps = 0;
  private lastRejection?: string;
  private itemCount = 0;
  private commandCounter = 0;
  private running = false;

  constructor(private readonly options: CanvasRuntimeOptions) {
    const transport = options.transport ?? new WebSocketRoomTransport();
    this.client = new RoomClient({
      transport,
      join: {
        canvasId: options.canvasId,
        userId: options.userId,
        displayName: options.displayName,
        serverUrl: options.serverUrl,
      },
    });
    this.wireClient();
    this.driver.onMessage((message) => this.onSimulation(message));
  }

  async start(): Promise<void> {
    this.running = true;
    await this.client.connect();
  }

  stop(): void {
    this.running = false;
    for (const timer of this.timers) clearInterval(timer);
    this.timers = [];
    this.pointer?.destroy();
    this.keyboard?.destroy();
    this.driver.terminate();
    this.client.close();
    this.scene?.destroy();
  }

  // ---------- coordination ----------

  private wireClient(): void {
    this.client.on("joined", (result) => {
      void this.onJoined(result.canvas, result.snapshot, result.roomWasSleeping);
    });

    this.client.on("hostGranted", (epoch, snapshot) => {
      this.buffer.reset();
      this.reconciler.reset();
      this.driver.send({ type: "setHost", isHost: true, snapshot });
      // Rebuilding the world drops the local avatar, so add it again.
      this.spawnLocalAvatar();
      this.itemCount = snapshot?.items.length ?? 0;
      void epoch;
    });

    this.client.on("hostChanged", (_epoch, hostClientId) => {
      // Spec 11.2. Clear stale interpolation history when the epoch changes.
      this.buffer.reset();
      this.reconciler.reset();
      if (hostClientId !== this.client.clientId) {
        this.driver.send({ type: "setHost", isHost: false });
        this.spawnLocalAvatar();
      }
    });

    this.client.on("fullState", (state, _epoch, tick) => {
      if (this.client.isHost) return;
      this.buffer.push(tick, state.entities.map(fromEntityState));
      this.itemCount = state.entities.length;
    });

    this.client.on("stateDelta", (delta, _epoch, tick) => {
      if (this.client.isHost) return;
      this.buffer.pushDelta(
        tick,
        delta.entities.map(fromEntityState),
        delta.removedEntityIds,
      );
    });

    this.client.on("effect", (event) => {
      this.scene?.effects.apply({
        tick: this.tick,
        entityId: event.entityId,
        effect: event.effect,
        mode: (event.mode as "oneShot" | "start" | "stop") || "oneShot",
        params: undefined,
      });
    });

    this.client.on("playerInput", (input, fromClientId) => {
      if (!this.client.isHost) return;
      this.driver.send({
        type: "input",
        entityId: avatarEntityId(fromClientId),
        direction: input.direction ?? { x: 0, y: 0 },
        intensity: input.intensity,
        inputSequence: input.inputSequence,
      });
    });

    this.client.on("presence", (peers) => {
      if (!this.client.isHost) return;
      // The host keeps one avatar for each connected client.
      for (const peer of peers) {
        this.driver.send({
          type: "addAvatar",
          spawn: {
            entityId: avatarEntityId(peer.clientId),
            clientId: peer.clientId,
            userId: peer.userId,
            position: this.spawnPosition(),
          },
        });
      }
    });

    this.client.on("durableAccepted", (command) => {
      this.applyAcceptedCommand(command);
    });

    this.client.on("durableRejected", (_command, reason) => {
      this.lastRejection = reason;
    });

    this.client.on("error", (code, message) => {
      this.lastRejection = `${code}: ${message}`;
    });
  }

  private spawnPosition(): { x: number; y: number } {
    const spawn = this.canvas?.spawnPoints[0]?.position;
    if (spawn) {
      // Spread avatars a little so they do not stack on one point.
      return { x: spawn.x + (Math.random() - 0.5) * 6, y: spawn.y };
    }
    return { x: 10, y: 10 };
  }

  private async onJoined(
    canvas: CanvasDefinition,
    snapshot: CanvasSnapshot,
    wasSleeping: boolean,
  ): Promise<void> {
    if (this.canvas) return;
    this.canvas = canvas;
    this.localAvatarId = avatarEntityId(this.client.clientId);
    this.itemCount = snapshot.items.length;

    this.scene = new PixiScene(canvas, this.options.definitions, this.options.scene);
    await this.scene.mount(this.options.mount);
    this.pointer = new PointerDragController(this.scene.app.canvas as unknown as HTMLElement);
    this.keyboard = new KeyboardController();

    this.driver.send({
      type: "init",
      canvas,
      definitions: this.options.definitions,
      tickRate: this.client.tickRate,
      isHost: this.client.isHost,
      snapshot: this.client.isHost ? snapshot : undefined,
      localAvatar: {
        entityId: this.localAvatarId,
        clientId: this.client.clientId,
        userId: this.options.userId,
        position: this.spawnPosition(),
      },
    });

    this.startSendLoops();
    this.startRenderLoop();
    this.watchVisibility();
    void wasSleeping;
  }

  private spawnLocalAvatar(): void {
    if (!this.localAvatarId) return;
    this.driver.send({
      type: "addAvatar",
      spawn: {
        entityId: this.localAvatarId,
        clientId: this.client.clientId,
        userId: this.options.userId,
        position: this.spawnPosition(),
      },
    });
  }

  // ---------- loops ----------

  private startSendLoops(): void {
    const rates = this.options.rates ?? {};
    const inputHz = rates.inputHz ?? 30;
    const deltaHz = rates.deltaHz ?? 15;
    const keyframeHz = rates.keyframeHz ?? 2;
    const checkpointHz = rates.checkpointHz ?? 1;

    this.timers.push(
      setInterval(() => this.sendInput(), 1000 / inputHz),
      setInterval(() => this.sendDelta(false), 1000 / deltaHz),
      setInterval(() => this.sendDelta(true), 1000 / keyframeHz),
      setInterval(() => this.requestCheckpoint(), 1000 / checkpointHz),
    );
  }

  private sendInput(): void {
    const intent = this.mergedIntent();
    this.inputSequence++;
    // The host applies its own input directly; a peer sends it through the relay.
    this.driver.send({
      type: "input",
      entityId: this.localAvatarId,
      direction: intent.direction,
      intensity: intent.intensity,
      inputSequence: this.inputSequence,
    });
    if (!this.client.isHost) {
      this.client.sendInput({
        inputSequence: this.inputSequence,
        direction: intent.direction,
        intensity: intent.intensity,
        clientTimeUnixMs: Date.now(),
        held: intent.held,
      });
    }
  }

  private mergedIntent() {
    const pointer = this.pointer?.intent;
    if (pointer && pointer.intensity > 0) return pointer;
    const keyboard = this.keyboard?.intent;
    if (keyboard && keyboard.intensity > 0) return keyboard;
    return { direction: { x: 0, y: 0 }, intensity: 0, held: false };
  }

  private sendDelta(keyframe: boolean): void {
    if (!this.client.isHost || this.hostEntities.length === 0) return;
    const entities = this.hostEntities.map(toEntityState);
    if (keyframe) {
      this.client.sendFullState(
        {
          entities,
          avatars: this.hostEntities
            .filter((entity) => entity.kind === "avatar")
            .map((entity) => ({
              entityId: entity.id,
              clientId: clientIdOf(entity.id),
              userId: entity.userId ?? "",
              displayName: entity.userId ?? "",
            })),
          sceneRevision: this.client.sceneRevision,
          tickRate: this.client.tickRate,
        },
        this.tick,
      );
      return;
    }
    this.client.sendStateDelta(
      { entities, removedEntityIds: [], sceneRevision: this.client.sceneRevision },
      this.tick,
    );
  }

  private requestCheckpoint(): void {
    if (!this.client.isHost) return;
    this.driver.send({ type: "requestSnapshot", final: false });
  }

  private startRenderLoop(): void {
    const scene = this.scene;
    if (!scene) return;
    scene.app.ticker.add(() => {
      if (!this.running) return;
      const nowMs = performance.now();
      const deltaMs = scene.frameDelta(nowMs);
      this.renderFps = deltaMs > 0 ? 1000 / deltaMs : 0;
      scene.update(this.entitiesToDraw(nowMs), deltaMs);
      this.options.onDiagnostics?.(this.diagnostics());
    });
  }

  private entitiesToDraw(nowMs: number): RenderEntity[] {
    if (this.client.isHost) return this.hostEntities;

    const remote = this.buffer.sample(nowMs).filter((entity) => entity.id !== this.localAvatarId);
    const canonicalLocal = this.buffer
      .sample(nowMs)
      .find((entity) => entity.id === this.localAvatarId);

    if (this.localPrediction) {
      if (canonicalLocal) {
        this.reconciler.observe(canonicalLocal, this.localPrediction);
      }
      const corrected = this.reconciler.correct(this.localPrediction);
      remote.push({
        ...this.localPrediction,
        x: corrected.x,
        y: corrected.y,
        extrapolated: false,
      });
    }
    return remote;
  }

  private watchVisibility(): void {
    document.addEventListener("visibilitychange", () => {
      const visible = document.visibilityState === "visible";
      this.client.health.pageVisible = visible;
      // Spec 11.4. Yield before the browser throttles the tab.
      if (!visible && this.client.isHost) this.client.yieldHost("page_hidden");
      this.client.setHostEligible(visible);
    });
  }

  // ---------- simulation messages ----------

  private onSimulation(message: SimulationResponse): void {
    switch (message.type) {
      case "render": {
        this.tick = message.tick;
        this.stats = { ...message.stats, behaviorErrors: message.stats.behaviorErrors };
        this.client.health.simulationHz = message.stats.hz;
        this.client.health.workerDriftMs = message.stats.driftMs;
        if (this.client.isHost) {
          this.hostEntities = message.entities;
          this.itemCount = message.entities.filter((e) => e.kind === "item").length;
        } else {
          this.localPrediction = message.entities.find(
            (entity) => entity.id === this.localAvatarId,
          );
        }
        break;
      }
      case "effects":
        for (const effect of message.effects) {
          this.scene?.effects.apply(effect);
          if (this.client.isHost) {
            this.client.sendEffect(
              {
                entityId: effect.entityId,
                effect: effect.effect,
                mode: effect.mode,
                paramsJson: effect.params ? toJsonBytes(effect.params) : new Uint8Array(),
              },
              message.tick,
            );
          }
        }
        break;
      case "snapshot":
        this.client.sendCheckpoint(
          message.snapshot,
          message.snapshot.checkpointRevision,
          message.final,
        );
        break;
      case "error":
        this.lastRejection = `simulation: ${message.message}`;
        break;
    }
  }

  // ---------- durable mutations ----------

  /** Spec 14.1. Every durable edit goes through the backend. */
  spawnItem(definitionId: string, at: { x: number; y: number }, rotation = 0): void {
    const definition = this.options.definitions.find(
      (candidate) => candidate.definitionId === definitionId,
    );
    if (!definition || !this.canvas) return;
    const config = resolveItemConfig(
      definition as ItemDefinition<Record<string, unknown>>,
      {
        width: this.canvas.size.width,
        height: this.canvas.size.height,
        orientation: this.canvas.orientation,
      },
    );
    this.client.sendDurableCommand({
      commandId: this.nextCommandId(),
      kind: DurableCommandKind.DURABLE_SPAWN_ITEM,
      entityId: "",
      definitionId,
      definitionVersion: definition.version,
      position: at,
      rotation,
      z: 0,
      configJson: toJsonBytes(config),
      preview: false,
    });
  }

  moveItem(entityId: string, transform: Transform, preview = false): void {
    this.client.sendDurableCommand({
      commandId: this.nextCommandId(),
      kind: DurableCommandKind.DURABLE_MOVE_ITEM,
      entityId,
      definitionId: "",
      definitionVersion: 0,
      position: { x: transform.x, y: transform.y },
      rotation: transform.rotation,
      z: transform.z ?? 0,
      configJson: new Uint8Array(),
      preview,
    });
  }

  deleteItem(entityId: string): void {
    this.client.sendDurableCommand({
      commandId: this.nextCommandId(),
      kind: DurableCommandKind.DURABLE_DELETE_ITEM,
      entityId,
      definitionId: "",
      definitionVersion: 0,
      position: { x: 0, y: 0 },
      rotation: 0,
      z: 0,
      configJson: new Uint8Array(),
      preview: false,
    });
  }

  private nextCommandId(): string {
    return `${this.client.clientId}-${++this.commandCounter}`;
  }

  private applyAcceptedCommand(command: DurableCommand): void {
    if (!this.client.isHost) return;
    switch (command.kind) {
      case DurableCommandKind.DURABLE_SPAWN_ITEM:
        this.driver.send({
          type: "addItem",
          instance: {
            entityId: command.entityId,
            canvasId: this.options.canvasId,
            definitionId: command.definitionId,
            definitionVersion: command.definitionVersion,
            ownerUserId: this.options.userId,
            transform: {
              x: command.position?.x ?? 0,
              y: command.position?.y ?? 0,
              rotation: command.rotation,
              z: command.z || undefined,
            },
            resolvedConfig: JSON.parse(
              new TextDecoder().decode(command.configJson || new Uint8Array([123, 125])),
            ),
            createdAt: new Date().toISOString(),
            sceneRevision: this.client.sceneRevision,
          },
        });
        break;
      case DurableCommandKind.DURABLE_DELETE_ITEM:
        this.driver.send({ type: "removeItem", entityId: command.entityId });
        break;
      case DurableCommandKind.DURABLE_MOVE_ITEM:
      case DurableCommandKind.DURABLE_ROTATE_ITEM:
        this.driver.send({
          type: "moveItem",
          entityId: command.entityId,
          transform: {
            x: command.position?.x ?? 0,
            y: command.position?.y ?? 0,
            rotation: command.rotation,
            z: command.z || undefined,
          },
          preview: command.preview,
        });
        break;
    }
  }

  diagnostics(): RuntimeDiagnostics {
    return {
      status: this.client.isHost ? "host" : "peer",
      isHost: this.client.isHost,
      hostEpoch: this.client.hostEpoch,
      hostClientId: this.client.hostClientId,
      clientId: this.client.clientId,
      peers: this.client.peers.length,
      tick: this.tick,
      simulationHz: this.stats.hz,
      driftMs: this.stats.driftMs,
      worstStepMs: this.stats.worstStepMs,
      awakeBodies: this.stats.awakeBodies,
      renderFps: this.renderFps,
      interpolationDepth: this.buffer.depth,
      extrapolations: this.buffer.extrapolationCount,
      reconcileError: this.reconciler.lastErrorDistance,
      sceneRevision: this.client.sceneRevision,
      itemCount: this.itemCount,
      lastRejection: this.lastRejection,
    };
  }
}

const avatarEntityId = (clientId: string): string => `avatar:${clientId}`;
const clientIdOf = (entityId: string): string => entityId.replace(/^avatar:/, "");

const toEntityState = (entity: RenderEntity): EntityState => ({
  entityId: entity.id,
  position: { x: entity.x, y: entity.y },
  rotation: entity.rotation,
  velocity: { x: entity.vx, y: entity.vy },
  angularVelocity: entity.angularVelocity,
  z: entity.z ?? 0,
  vz: 0,
  lastProcessedInputSequence: entity.lastProcessedInputSequence ?? 0,
  spriteVariant: entity.variant ?? "",
  behaviorStateJson: new Uint8Array(),
  quarantined: entity.quarantined ?? false,
  definitionId: entity.definitionId,
});

const fromEntityState = (state: EntityState): RenderEntity => ({
  id: state.entityId,
  kind: state.entityId.startsWith("avatar:") ? "avatar" : "item",
  definitionId: state.definitionId,
  x: state.position?.x ?? 0,
  y: state.position?.y ?? 0,
  rotation: state.rotation,
  z: state.z || undefined,
  vx: state.velocity?.x ?? 0,
  vy: state.velocity?.y ?? 0,
  angularVelocity: state.angularVelocity,
  variant: state.spriteVariant || undefined,
  lastProcessedInputSequence: state.lastProcessedInputSequence,
  quarantined: state.quarantined,
});
