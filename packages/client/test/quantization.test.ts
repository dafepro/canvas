import { describe, expect, it } from "vitest";
import { EntityState } from "@canvas-physics/protocol";
import {
  dequantizeTransform,
  quantizeTransform,
} from "../src/net/quantization.js";

describe("realtime transform quantization", () => {
  it("round-trips within the declared visual precision", () => {
    const source = {
      x: 52.345,
      y: -3.216,
      rotation: Math.PI / 3,
      vx: -12.345,
      vy: 0.006,
      angularVelocity: -0.8764,
      z: 2.345,
      vz: -1.234,
    };
    const decoded = dequantizeTransform(quantizeTransform(source));

    expect(Math.abs(decoded.x - source.x)).toBeLessThanOrEqual(0.0051);
    expect(Math.abs(decoded.y - source.y)).toBeLessThanOrEqual(0.0051);
    expect(Math.abs(decoded.rotation - source.rotation)).toBeLessThanOrEqual(0.00051);
    expect(Math.abs(decoded.vx - source.vx)).toBeLessThanOrEqual(0.0051);
    expect(Math.abs(decoded.angularVelocity - source.angularVelocity)).toBeLessThanOrEqual(0.00051);
  });

  it("keeps a representative realtime entity within its byte budget", () => {
    const quantized = EntityState.encode({
      entityId: "avatar:c-12345678",
      lastProcessedInputSequence: 42,
      spriteVariant: "",
      spriteAnimation: "",
      animationEpoch: 0,
      behaviorStateJson: new Uint8Array(),
      quarantined: false,
      definitionId: "",
      disabled: false,
      teleportEpoch: 0,
      respawning: false,
      quantizedTransform: quantizeTransform({
        x: 52.34,
        y: 31.25,
        rotation: 1.047,
        vx: -12.34,
        vy: 3.21,
        angularVelocity: -0.876,
        z: 2.34,
        vz: -1.23,
      }),
    }).finish();

    expect(quantized.byteLength).toBeLessThanOrEqual(48);
  });
});
