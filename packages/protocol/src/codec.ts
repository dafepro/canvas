import { RoomEnvelope } from "./gen/room.js";

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

/** Spec 12.3. Binary envelopes on the wire, JSON for editable definitions. */
export const encodeEnvelope = (envelope: RoomEnvelope): Uint8Array =>
  RoomEnvelope.encode(envelope).finish();

export const decodeEnvelope = (bytes: Uint8Array): RoomEnvelope =>
  RoomEnvelope.decode(bytes);

export const toJsonBytes = (value: unknown): Uint8Array =>
  textEncoder.encode(JSON.stringify(value));

export const fromJsonBytes = <T>(bytes: Uint8Array | undefined): T | undefined => {
  if (!bytes || bytes.length === 0) return undefined;
  return JSON.parse(textDecoder.decode(bytes)) as T;
};
