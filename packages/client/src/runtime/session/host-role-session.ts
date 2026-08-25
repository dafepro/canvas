import type { CanvasDefinition, CanvasSnapshot, ItemDefinition } from "@canvas-physics/core";
import type { SimulationRequest, SimulationResponse } from "../../simulation/messages.js";
import type { AvatarSpawn } from "../../simulation/rapier-world.js";
import type { HostLease } from "../../net/room-client.js";
import {
  systemSessionClock,
  type SessionClock,
  type SessionInterval,
  type SessionTimeout,
} from "./session-clock.js";

export interface HostRoleRates {
  readonly deltaHz?: number;
  readonly keyframeHz?: number;
  readonly checkpointHz?: number;
}

export interface HostRoleInitialize {
  readonly lease: HostLease;
  readonly canvas: CanvasDefinition;
  readonly definitions: ItemDefinition[];
  readonly tickRate: number;
  readonly snapshot: CanvasSnapshot;
  readonly wakeFromSleep: boolean;
  readonly localAvatar: AvatarSpawn;
}

export interface HostRoleGrant {
  readonly lease: HostLease;
  readonly snapshot?: CanvasSnapshot;
  readonly reason: string;
}

export interface HostRoleChange {
  readonly lease: HostLease;
  readonly reason: string;
}

export type HostRoleEffect =
  | { readonly type: "simulate"; readonly request: SimulationRequest }
  | { readonly type: "publishFrame"; readonly keyframe: boolean; readonly lease: HostLease }
  | {
      readonly type: "requestCheckpoint";
      readonly generation: number;
      readonly hostEpoch: number;
      readonly sceneRevision: number;
      readonly final: boolean;
      readonly lease: HostLease;
    }
  | { readonly type: "yieldHost"; readonly reason: string; readonly lease: HostLease }
  | {
      readonly type: "roleRebuilt";
      readonly isHost: boolean;
      readonly epoch: number;
      readonly snapshot?: CanvasSnapshot;
      readonly request: Extract<SimulationRequest, { type: "setHost" }>;
    };

export interface HostRoleDiagnostics {
  readonly hostEpoch: number;
  readonly hostMigrations: number;
  readonly lastMigrationReason?: string;
  readonly quarantined: number;
  readonly staleSimulationResponses: number;
  readonly invariantViolations: number;
}

export interface HostRoleSessionOptions {
  readonly clock?: SessionClock;
  readonly rates?: HostRoleRates;
  readonly sceneRevision?: () => number;
  readonly emit: (effect: HostRoleEffect) => void;
}

/** Owns the local simulation role, its generation, and all host-only schedules. */
export class HostRoleSession {
  private readonly clock: SessionClock;
  private readonly rates: Required<HostRoleRates>;
  private leaseValue: HostLease = Object.freeze({
    epoch: 0,
    hostClientId: "",
    localClientId: "",
    isHost: false,
  });
  private generationValue = 0;
  private readyValue = false;
  private initialized = false;
  private visible = true;
  private destroyed = false;
  private migrations = 0;
  private migrationReason?: string;
  private quarantinedCount = 0;
  private staleResponses = 0;
  private invariantViolationCount = 0;
  private readonly avatarIds = new Set<string>();
  private schedules: SessionInterval[] = [];
  private finalCheckpoint?: {
    generation: number;
    timeout: SessionTimeout;
    resolve: () => void;
  };

  constructor(private readonly options: HostRoleSessionOptions) {
    this.clock = options.clock ?? systemSessionClock;
    this.rates = {
      deltaHz: options.rates?.deltaHz ?? 15,
      keyframeHz: options.rates?.keyframeHz ?? 2,
      checkpointHz: options.rates?.checkpointHz ?? 1,
    };
  }

  get isHost(): boolean {
    return this.leaseValue.isHost;
  }

  get hostEpoch(): number {
    return this.leaseValue.epoch;
  }

  get hostLease(): HostLease {
    return this.leaseValue;
  }

  get generation(): number {
    return this.generationValue;
  }

  get simulationReady(): boolean {
    return this.readyValue;
  }

  get hostAvatarIds(): ReadonlySet<string> {
    return new Set(this.avatarIds);
  }

  get diagnostics(): HostRoleDiagnostics {
    return Object.freeze({
      hostEpoch: this.leaseValue.epoch,
      hostMigrations: this.migrations,
      ...(this.migrationReason ? { lastMigrationReason: this.migrationReason } : {}),
      quarantined: this.quarantinedCount,
      staleSimulationResponses: this.staleResponses,
      invariantViolations: this.invariantViolationCount,
    });
  }

  initialize(input: HostRoleInitialize): void {
    if (this.destroyed || this.initialized) return;
    this.initialized = true;
    this.leaseValue = input.lease;
    this.readyValue = false;
    this.avatarIds.clear();
    if (input.lease.isHost) this.avatarIds.add(input.localAvatar.entityId);
    const generation = ++this.generationValue;
    this.emit({
      type: "simulate",
      request: {
        type: "init",
        generation,
        canvas: input.canvas,
        definitions: input.definitions,
        tickRate: input.tickRate,
        isHost: input.lease.isHost,
        snapshot: input.lease.isHost ? input.snapshot : undefined,
        wakeFromSleep: input.wakeFromSleep,
        localAvatar: input.localAvatar,
      },
    });
    if (input.lease.isHost) this.startSchedules();
  }

  grant(input: HostRoleGrant): boolean {
    if (this.destroyed || !this.acceptEpoch(input.lease.epoch)) return false;
    if (!this.visible) {
      this.leaseValue = Object.freeze({ ...input.lease, isHost: false });
      this.emit({ type: "yieldHost", reason: "page_hidden", lease: input.lease });
      return false;
    }
    if (input.reason && input.reason !== "first_join") {
      this.migrations++;
      this.migrationReason = input.reason;
    }
    this.leaseValue = input.lease;
    this.readyValue = false;
    this.cancelFinalCheckpoint();
    this.stopSchedules();
    this.avatarIds.clear();
    const generation = ++this.generationValue;
    this.emit({
      type: "roleRebuilt",
      isHost: true,
      epoch: input.lease.epoch,
      snapshot: input.snapshot,
      request: {
        type: "setHost",
        generation,
        isHost: true,
        snapshot: input.snapshot,
        wakeFromSleep: false,
      },
    });
    this.startSchedules();
    return true;
  }

  change(input: HostRoleChange): boolean {
    if (this.destroyed || !this.acceptEpoch(input.lease.epoch)) return false;
    this.migrations++;
    this.migrationReason = input.reason || undefined;
    const rebuild = input.lease.isHost !== this.leaseValue.isHost || !input.lease.isHost;
    this.leaseValue = input.lease;
    this.cancelFinalCheckpoint();
    this.stopSchedules();
    if (!rebuild) {
      if (this.isHost) this.startSchedules();
      return true;
    }
    this.readyValue = false;
    this.avatarIds.clear();
    const generation = ++this.generationValue;
    this.emit({
      type: "roleRebuilt",
      isHost: input.lease.isHost,
      epoch: input.lease.epoch,
      request: { type: "setHost", generation, isHost: input.lease.isHost },
    });
    if (this.isHost) this.startSchedules();
    return true;
  }

  setPageVisible(visible: boolean): void {
    if (this.destroyed || this.visible === visible) return;
    this.visible = visible;
    if (!visible && this.isHost) {
      this.emit({ type: "yieldHost", reason: "page_hidden", lease: this.leaseValue });
    }
  }

  acceptSimulation(message: SimulationResponse): boolean {
    if (this.destroyed || message.generation !== this.generationValue) {
      this.staleResponses++;
      return false;
    }
    if (message.type === "ready") this.readyValue = true;
    if (message.type === "snapshot" && message.final) this.completeFinalCheckpoint();
    return true;
  }

  recordHostFrame(quarantined: number): void {
    if (this.isHost) this.quarantinedCount = quarantined;
  }

  sendSimulation(request: SimulationRequest): void {
    if (!this.destroyed) this.emit({ type: "simulate", request });
  }

  recordAvatarRequest(request: SimulationRequest): void {
    if (request.type === "addAvatar" && this.isHost) {
      this.avatarIds.add(request.spawn.entityId);
    }
    if (!this.destroyed) this.emit({ type: "simulate", request });
  }

  requestFinalCheckpoint(sceneRevision: number, timeoutMs: number): Promise<void> {
    if (this.destroyed || !this.isHost || !this.readyValue) return Promise.resolve();
    this.stopSchedules();
    this.cancelFinalCheckpoint();
    const generation = this.generationValue;
    return new Promise<void>((resolve) => {
      const timeout = this.clock.setTimeout(() => {
        if (this.finalCheckpoint?.generation !== generation) return;
        this.finalCheckpoint = undefined;
        resolve();
      }, timeoutMs);
      this.finalCheckpoint = { generation, timeout, resolve };
      this.emit({
        type: "requestCheckpoint",
        generation,
        hostEpoch: this.leaseValue.epoch,
        sceneRevision,
        final: true,
        lease: this.leaseValue,
      });
    });
  }

  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    this.stopSchedules();
    this.cancelFinalCheckpoint();
    this.avatarIds.clear();
    this.readyValue = false;
  }

  private acceptEpoch(epoch: number): boolean {
    if (epoch >= this.leaseValue.epoch) return true;
    this.invariantViolationCount++;
    return false;
  }

  private startSchedules(): void {
    if (this.destroyed || !this.initialized || !this.isHost || this.schedules.length > 0) return;
    this.schedules = [
      this.clock.setInterval(
        () => this.emit({
          type: "publishFrame",
          keyframe: false,
          lease: this.leaseValue,
        }),
        1000 / this.rates.deltaHz,
      ),
      this.clock.setInterval(
        () => this.emit({
          type: "publishFrame",
          keyframe: true,
          lease: this.leaseValue,
        }),
        1000 / this.rates.keyframeHz,
      ),
      this.clock.setInterval(
        () => this.emit({
          type: "requestCheckpoint",
          generation: this.generationValue,
          hostEpoch: this.leaseValue.epoch,
          sceneRevision: this.options.sceneRevision?.() ?? 0,
          final: false,
          lease: this.leaseValue,
        }),
        1000 / this.rates.checkpointHz,
      ),
    ];
  }

  private stopSchedules(): void {
    for (const schedule of this.schedules) this.clock.clearInterval(schedule);
    this.schedules = [];
  }

  private completeFinalCheckpoint(): void {
    const pending = this.finalCheckpoint;
    if (!pending || pending.generation !== this.generationValue) return;
    this.clock.clearTimeout(pending.timeout);
    this.finalCheckpoint = undefined;
    pending.resolve();
  }

  private cancelFinalCheckpoint(): void {
    const pending = this.finalCheckpoint;
    if (!pending) return;
    this.clock.clearTimeout(pending.timeout);
    this.finalCheckpoint = undefined;
    pending.resolve();
  }

  private emit(effect: HostRoleEffect): void {
    if (!this.destroyed) this.options.emit(effect);
  }
}
