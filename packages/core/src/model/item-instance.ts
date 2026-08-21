export interface Transform {
  x: number;
  y: number;
  rotation: number;
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
  resolvedConfig: Config;
  behaviorState?: State;
  createdAt: string;
  sceneRevision: number;
}
