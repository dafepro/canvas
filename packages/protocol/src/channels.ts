import type { RoomEnvelope } from "./gen/room.js";

/** Spec 12.4. */
export type MessageClass =
  | "coordination"
  | "durableMutation"
  | "input"
  | "stateDelta"
  | "keyframe"
  | "effect";

export type DeliveryChannel = "reliable" | "realtime";

export type PayloadCase =
  | "join"
  | "joinAccepted"
  | "presence"
  | "playerInput"
  | "stateDelta"
  | "fullState"
  | "effectEvent"
  | "hostControl"
  | "durableCommand"
  | "durableResult"
  | "checkpoint"
  | "heartbeat"
  | "error";

const payloadCases: PayloadCase[] = [
  "join",
  "joinAccepted",
  "presence",
  "playerInput",
  "stateDelta",
  "fullState",
  "effectEvent",
  "hostControl",
  "durableCommand",
  "durableResult",
  "checkpoint",
  "heartbeat",
  "error",
];

/** Which payload the envelope carries, or undefined when it carries none. */
export const payloadCase = (envelope: RoomEnvelope): PayloadCase | undefined =>
  payloadCases.find((name) => envelope[name] !== undefined);

export const messageClassOf = (envelope: RoomEnvelope): MessageClass => {
  switch (payloadCase(envelope)) {
    case "playerInput":
      return "input";
    case "stateDelta":
      return "stateDelta";
    case "fullState":
      return "keyframe";
    case "effectEvent":
      return "effect";
    case "durableCommand":
    case "durableResult":
      return "durableMutation";
    default:
      return "coordination";
  }
};

/**
 * Newest-matters-most classes take the realtime channel. Everything else needs
 * reliable ordered delivery. A WebSocket transport uses one socket for both, so
 * the value only guides a later WebRTC transport (spec 12.2).
 */
export const channelFor = (messageClass: MessageClass): DeliveryChannel =>
  messageClass === "input" || messageClass === "stateDelta" ? "realtime" : "reliable";

/** An empty envelope with the required scalar fields set. */
export const envelope = (
  roomId: string,
  fields: Partial<RoomEnvelope> = {},
): RoomEnvelope => ({
  roomId,
  hostEpoch: 0,
  sequence: 0,
  tick: 0,
  senderClientId: "",
  ...fields,
});
