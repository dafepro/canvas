export interface Transform {
  x: number;
  y: number;
  rotation: number;
  /** Uniform visual and collider scale. Defaults to 1 when omitted. */
  scale?: number;
  /** Optional top-down elevation channel. */
  z?: number;
}

/** Spec 7.2. */
export interface ItemInstance<Config = unknown, State = unknown> {
  entityId: string;
  canvasId: string;
  definitionId: string;
  definitionVersion: number;
  ownerUserId: string;
  transform: Transform;
  /** Owner-controlled pause of physics, collision, behavior, and timers. */
  isolated?: boolean;
  resolvedConfig: Config;
  behaviorState?: State;
  /** Version of behaviorState before any registered migration is applied. */
  behaviorStateVersion?: number;
  createdAt: string;
  sceneRevision: number;
}
