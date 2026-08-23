import type { QuantizedTransform } from "@canvas-physics/protocol";

const POSITION_SCALE = 100;
const ROTATION_SCALE = 1000;
const VELOCITY_SCALE = 100;
const UNIFORM_SCALE = 1000;
const INT32_MIN = -0x8000_0000;
const INT32_MAX = 0x7fff_ffff;

const fixed = (value: number, scale: number): number =>
  Math.max(INT32_MIN, Math.min(INT32_MAX, Math.round(value * scale)));

export interface RealtimeTransform {
  x: number;
  y: number;
  rotation: number;
  vx: number;
  vy: number;
  angularVelocity: number;
  z?: number;
  vz?: number;
  scale?: number;
}

export const quantizeTransform = (value: RealtimeTransform): QuantizedTransform => ({
  x: fixed(value.x, POSITION_SCALE),
  y: fixed(value.y, POSITION_SCALE),
  rotation: fixed(value.rotation, ROTATION_SCALE),
  vx: fixed(value.vx, VELOCITY_SCALE),
  vy: fixed(value.vy, VELOCITY_SCALE),
  angularVelocity: fixed(value.angularVelocity, ROTATION_SCALE),
  z: fixed(value.z ?? 0, POSITION_SCALE),
  vz: fixed(value.vz ?? 0, VELOCITY_SCALE),
  scale: fixed(value.scale ?? 1, UNIFORM_SCALE),
});

export const dequantizeTransform = (
  value: QuantizedTransform,
): Required<RealtimeTransform> => ({
  x: value.x / POSITION_SCALE,
  y: value.y / POSITION_SCALE,
  rotation: value.rotation / ROTATION_SCALE,
  vx: value.vx / VELOCITY_SCALE,
  vy: value.vy / VELOCITY_SCALE,
  angularVelocity: value.angularVelocity / ROTATION_SCALE,
  z: value.z / POSITION_SCALE,
  vz: value.vz / VELOCITY_SCALE,
  scale: value.scale / UNIFORM_SCALE,
});
