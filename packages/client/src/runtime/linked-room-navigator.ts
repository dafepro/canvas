import {
  roomTravelRequestFromEffect,
  type EffectEmission,
  type RoomLinkDefinition,
  type RoomLinkGraph,
} from "@canvas-physics/core";

export interface RoomOpenRequest {
  roomId: string;
  fromRoomId?: string;
  viaLinkId?: string;
  arrivalSpawnPointId?: string;
}

/** Adapter implemented by CanvasRuntime or another RoomSession presentation. */
export interface LinkedRoomHandle {
  readonly roomId: string;
  readonly avatarEntityId: string;
  subscribeEffects(observer: (effect: Readonly<EffectEmission>) => void): () => void;
  /** Promotes a staged, ready room into the visible presentation. */
  activate?(): void | Promise<void>;
  /** Gracefully leaves and disposes this room. */
  close(): void | Promise<void>;
}

export interface LinkedRoomNavigatorOptions {
  graph: RoomLinkGraph;
  /** Must resolve only after the room is joined and ready; it may remain staged. */
  openRoom(request: Readonly<RoomOpenRequest>): Promise<LinkedRoomHandle>;
  authorize?: (
    link: Readonly<RoomLinkDefinition>,
  ) => boolean | Promise<boolean>;
  onChanged?: (roomId: string, previousRoomId?: string) => void;
  onError?: (error: Error) => void;
}

interface ReturnStep {
  originRoomId: string;
  returnLinkId: string;
}

/**
 * Performs fail-safe, application-authorized room replacement. A destination
 * is ready and activated before the origin is closed. Failed opens leave the
 * current room untouched, and the validated reverse route powers back().
 */
export class LinkedRoomNavigator {
  private current?: LinkedRoomHandle;
  private unsubscribe?: () => void;
  private transition?: Promise<boolean>;
  private readonly history: ReturnStep[] = [];

  constructor(private readonly options: LinkedRoomNavigatorOptions) {}

  get currentRoomId(): string | undefined {
    return this.current?.roomId;
  }

  get canGoBack(): boolean {
    return this.history.length > 0;
  }

  async start(roomId: string): Promise<void> {
    if (this.current) throw new Error("linked room navigator is already started");
    const room = await this.options.openRoom({ roomId });
    if (room.roomId !== roomId) {
      await room.close();
      throw new Error(`room factory opened '${room.roomId}', expected '${roomId}'`);
    }
    await room.activate?.();
    this.install(room);
    this.options.onChanged?.(roomId);
  }

  travel(linkId: string): Promise<boolean> {
    if (!this.current) return Promise.reject(new Error("linked room navigator is not started"));
    if (this.transition) return Promise.resolve(false);
    const operation = this.performTravel(linkId).catch((cause: unknown) => {
      const error = cause instanceof Error ? cause : new Error(String(cause));
      this.options.onError?.(error);
      return false;
    });
    this.transition = operation;
    void operation.finally(() => {
      if (this.transition === operation) this.transition = undefined;
    });
    return operation;
  }

  back(): Promise<boolean> {
    const step = this.history.at(-1);
    return step ? this.travel(step.returnLinkId) : Promise.resolve(false);
  }

  async whenIdle(): Promise<void> {
    await this.transition;
  }

  async close(): Promise<void> {
    await this.whenIdle();
    this.unsubscribe?.();
    this.unsubscribe = undefined;
    const current = this.current;
    this.current = undefined;
    this.history.length = 0;
    await current?.close();
  }

  private async performTravel(linkId: string): Promise<boolean> {
    const origin = this.current!;
    const link = this.options.graph.resolve(origin.roomId, linkId);
    if (this.options.authorize && !(await this.options.authorize(link))) return false;

    const request: RoomOpenRequest = {
      roomId: link.toRoomId,
      fromRoomId: origin.roomId,
      viaLinkId: link.id,
      arrivalSpawnPointId: link.arrivalSpawnPointId,
    };
    let destination: LinkedRoomHandle | undefined;
    try {
      destination = await this.options.openRoom(request);
      if (destination.roomId !== link.toRoomId) {
        throw new Error(
          `room factory opened '${destination.roomId}', expected '${link.toRoomId}'`,
        );
      }
      await destination.activate?.();
    } catch (error) {
      await destination?.close();
      throw error;
    }

    const returnStep = this.history.at(-1);
    const isReturn = returnStep !== undefined &&
      returnStep.returnLinkId === link.id &&
      returnStep.originRoomId === link.toRoomId;

    this.unsubscribe?.();
    this.install(destination);
    if (isReturn) this.history.pop();
    else this.history.push({ originRoomId: origin.roomId, returnLinkId: link.returnLinkId });
    this.options.onChanged?.(destination.roomId, origin.roomId);
    try {
      await origin.close();
    } catch (cause) {
      this.options.onError?.(
        cause instanceof Error ? cause : new Error(`failed to close room: ${String(cause)}`),
      );
    }
    return true;
  }

  private install(room: LinkedRoomHandle): void {
    this.current = room;
    this.unsubscribe = room.subscribeEffects((effect) => {
      const request = roomTravelRequestFromEffect(effect, room.avatarEntityId);
      if (request) void this.travel(request.linkId);
    });
  }
}
