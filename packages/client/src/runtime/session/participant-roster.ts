import type { CanvasDefinition, CanvasSnapshot, Vec2 } from "@canvas-physics/core";
import type { Peer } from "@canvas-physics/protocol";
import type { RenderEntity, SimulationRequest } from "../../simulation/messages.js";

export type ParticipantStatus = "active" | "inactive" | "disconnected";

export interface ParticipantPresence {
  readonly participantId: string;
  readonly userId: string;
  readonly displayName: string;
  readonly connectionId?: string;
  readonly avatarEntityId: string;
  readonly status: ParticipantStatus;
  readonly isHost: boolean;
  readonly hostEligible: boolean;
}

export interface ParticipantAvatarProjectionContext {
  readonly canvas: CanvasDefinition;
  readonly previousStatus?: ParticipantStatus;
}

export interface ParticipantAvatarProjection {
  readonly position?: Vec2;
}

export type ParticipantAvatarProjector = (
  participant: Readonly<ParticipantPresence>,
  context: Readonly<ParticipantAvatarProjectionContext>,
) => ParticipantAvatarProjection | undefined;

export interface PresenceSnapshot {
  readonly participants: readonly Readonly<ParticipantPresence>[];
}

export interface ParticipantRosterOptions {
  readonly projectAvatar?: ParticipantAvatarProjector;
}

export interface HostAvatarReconciliationContext {
  readonly canvas: CanvasDefinition;
  readonly hostAvatarIds: Set<string>;
  readonly spawnPosition: (entityId: string) => Vec2;
}

type Observer<T> = (value: T) => void;

/** Stable participant identity, lifecycle, projection, and last validated pose. */
export class ParticipantRoster {
  private readonly participantsById = new Map<string, ParticipantPresence>();
  private readonly appliedStatusByAvatar = new Map<string, ParticipantStatus>();
  private readonly lastCanonicalPositions = new Map<string, Vec2>();
  private readonly observers = new Set<Observer<PresenceSnapshot>>();
  private peersValue?: readonly Peer[];
  private snapshotValue: PresenceSnapshot = Object.freeze({ participants: Object.freeze([]) });

  constructor(private readonly options: ParticipantRosterOptions = {}) {}

  get snapshot(): PresenceSnapshot {
    return this.snapshotValue;
  }

  get peers(): readonly Peer[] | undefined {
    return this.peersValue;
  }

  get presenceKnown(): boolean {
    return this.peersValue !== undefined;
  }

  get connectedAvatarIds(): readonly string[] {
    return Object.freeze((this.peersValue ?? []).map((peer) => avatarEntityId(peer.userId)));
  }

  subscribe(observer: Observer<PresenceSnapshot>): () => void {
    this.observers.add(observer);
    if (this.peersValue !== undefined) observer(this.snapshotValue);
    return () => this.observers.delete(observer);
  }

  clearObservers(): void {
    this.observers.clear();
  }

  updatePresence(peers: readonly Peer[]): void {
    this.peersValue = Object.freeze(peers.map((peer) => Object.freeze({ ...peer })));
    const connectedIds = new Set(peers.map((peer) => peer.userId));
    for (const [participantId, participant] of this.participantsById) {
      if (connectedIds.has(participantId)) continue;
      this.participantsById.set(participantId, {
        ...participant,
        connectionId: undefined,
        status: "disconnected",
        isHost: false,
        hostEligible: false,
      });
    }
    for (const peer of peers) {
      const current = this.participantsById.get(peer.userId);
      this.participantsById.set(peer.userId, {
        participantId: peer.userId,
        userId: peer.userId,
        displayName: peer.displayName,
        connectionId: peer.clientId,
        avatarEntityId: avatarEntityId(peer.userId),
        status:
          current?.connectionId === peer.clientId && current.status === "inactive"
            ? "inactive"
            : "active",
        isHost: peer.isHost,
        hostEligible: peer.hostEligible,
      });
    }
    this.publish();
  }

  setActivity(participantId: string, status: Exclude<ParticipantStatus, "disconnected">): boolean {
    const participant = this.participantsById.get(participantId);
    if (
      !participant ||
      participant.status === "disconnected" ||
      participant.status === status
    ) {
      return false;
    }
    this.participantsById.set(participantId, { ...participant, status });
    this.publish();
    return true;
  }

  observeCanonical(entities: readonly RenderEntity[]): void {
    this.lastCanonicalPositions.clear();
    let changed = false;
    for (const entity of entities) {
      if (entity.kind !== "avatar") continue;
      this.lastCanonicalPositions.set(entity.id, { x: entity.x, y: entity.y });
      if (entity.userId) {
        changed = this.setActivityWithoutPublish(
          entity.userId,
          entity.disabled ? "inactive" : "active",
        ) || changed;
      }
    }
    if (changed) this.publish();
  }

  loadSnapshotPositions(snapshot: CanvasSnapshot, preserveExisting = false): void {
    for (const avatar of snapshot.avatars) {
      if (preserveExisting && this.lastCanonicalPositions.has(avatar.entityId)) continue;
      this.lastCanonicalPositions.set(avatar.entityId, { ...avatar.position });
    }
  }

  spawnPosition(entityId: string, fallback: () => Vec2): Vec2 {
    const canonical = this.lastCanonicalPositions.get(entityId);
    return canonical ? { ...canonical } : fallback();
  }

  peerForConnection(connectionId: string): Peer | undefined {
    return this.peersValue?.find((peer) => peer.clientId === connectionId);
  }

  connectionId(participantId: string): string | undefined {
    return this.participantsById.get(participantId)?.connectionId;
  }

  resetHostProjection(): void {
    this.appliedStatusByAvatar.clear();
  }

  reconcileHostAvatars(
    context: HostAvatarReconciliationContext,
  ): SimulationRequest[] {
    const requests: SimulationRequest[] = [];
    for (const participant of this.participantsById.values()) {
      const entityId = participant.avatarEntityId;
      const previousStatus = this.appliedStatusByAvatar.get(entityId);
      const projection = previousStatus === participant.status
        ? undefined
        : this.options.projectAvatar?.(
            Object.freeze({ ...participant }),
            Object.freeze({ canvas: context.canvas, previousStatus }),
          );
      if (!context.hostAvatarIds.has(entityId)) {
        requests.push({
          type: "addAvatar",
          spawn: {
            entityId,
            clientId: participant.connectionId ?? "",
            userId: participant.userId,
            position: projection?.position ?? context.spawnPosition(entityId),
          },
        });
        context.hostAvatarIds.add(entityId);
      }
      if (previousStatus !== participant.status) {
        requests.push({
          type: "setAvatarLifecycle",
          entityId,
          disabled: participant.status !== "active",
          ...(projection?.position ? { position: projection.position } : {}),
        });
        this.appliedStatusByAvatar.set(entityId, participant.status);
      }
    }
    return requests;
  }

  private setActivityWithoutPublish(
    participantId: string,
    status: Exclude<ParticipantStatus, "disconnected">,
  ): boolean {
    const participant = this.participantsById.get(participantId);
    if (
      !participant ||
      participant.status === "disconnected" ||
      participant.status === status
    ) {
      return false;
    }
    this.participantsById.set(participantId, { ...participant, status });
    return true;
  }

  private publish(): void {
    const participants = Object.freeze(
      [...this.participantsById.values()]
        .sort((a, b) => a.participantId.localeCompare(b.participantId))
        .map((participant) => Object.freeze({ ...participant })),
    );
    this.snapshotValue = Object.freeze({ participants });
    for (const observer of this.observers) observer(this.snapshotValue);
  }
}

const avatarEntityId = (participantId: string): string => `avatar:${participantId}`;
