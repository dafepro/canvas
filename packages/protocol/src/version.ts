/** Bump the major value when the wire contract changes incompatibly. */
export const PROTOCOL_VERSION = 8;

export const isCompatible = (clientVersion: number): boolean =>
  clientVersion === PROTOCOL_VERSION;
