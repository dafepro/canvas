import { describe, expect, it, vi } from "vitest";
import { emptySnapshot } from "@canvas-physics/core";
import { toJsonBytes, type RoomEnvelope } from "@canvas-physics/protocol";

const sceneProbe = vi.hoisted(() => ({
  definitionCount: 0,
  cleanupCount: 0,
  resolveMount: undefined as (() => void) | undefined,
}));

vi.mock("../src/render/pixi-scene.js", () => ({
  PixiScene: class {
    readonly effects = { apply: () => undefined };
    private destroyed = false;

    constructor(_canvas: unknown, definitions: unknown[]) {
      sceneProbe.definitionCount = definitions.length;
    }

    mount(): Promise<void> {
      return new Promise((resolve) => { sceneProbe.resolveMount = resolve; });
    }

    destroy(): void {
      if (this.destroyed) return;
      this.destroyed = true;
      sceneProbe.cleanupCount++;
    }
  },
}));

import { CanvasRuntime } from "../src/runtime/canvas-runtime.js";
import { emptyTraffic, type JoinDescriptor, type RoomTransport, type TransportStatus } from "../src/net/transport.js";
import { SimulationDriver } from "../src/simulation/driver.js";
import { rocketCanvas, rocketCanvasDefinitions } from "../src/definitions/rocket-canvas.js";

class MountTransport implements RoomTransport {
  status: TransportStatus = "idle";
  readonly traffic = emptyTraffic();
  private readonly messages = new Set<(message: RoomEnvelope) => void>();
  private readonly statuses = new Set<(status: TransportStatus) => void>();

  async connect(_join: JoinDescriptor): Promise<void> {
    this.status = "open";
    for (const listener of this.statuses) listener("open");
  }
  sendReliable(): void {}
  sendRealtime(): void {}
  onMessage(listener: (message: RoomEnvelope) => void): () => void {
    this.messages.add(listener);
    return () => this.messages.delete(listener);
  }
  onStatus(listener: (status: TransportStatus) => void): () => void {
    this.statuses.add(listener);
    return () => this.statuses.delete(listener);
  }
  close(): void {
    this.status = "closed";
  }
  deliver(message: RoomEnvelope): void {
    for (const listener of this.messages) listener(message);
  }
}

describe("CanvasRuntime mount ownership", () => {
  it("shares the definition snapshot and cleans a stop-during-mount race once", async () => {
    sceneProbe.definitionCount = 0;
    sceneProbe.cleanupCount = 0;
    sceneProbe.resolveMount = undefined;
    const definitions = [...rocketCanvasDefinitions];
    const transport = new MountTransport();
    const runtime = new CanvasRuntime({
      roomId: "mount-race",
      serverUrl: "http://rooms.test",
      mount: {} as HTMLElement,
      definitions,
      transport,
      driver: new SimulationDriver(() => ({ send: () => undefined, terminate: () => undefined })),
    });
    definitions.length = 0;

    await runtime.start();
    const ready = runtime.whenReady();
    transport.deliver({
      roomId: "mount-race",
      hostEpoch: 1,
      sequence: 0,
      tick: 0,
      senderClientId: "",
      joinAccepted: {
        clientId: "client-1",
        userId: "user-1",
        displayName: "User One",
        sceneRevision: 0,
        hostEpoch: 1,
        hostClientId: "other-host",
        canvasDefinitionJson: toJsonBytes(rocketCanvas),
        snapshotJson: toJsonBytes(emptySnapshot(rocketCanvas.id, rocketCanvas.version)),
        roomWasSleeping: false,
        tickRate: 60,
      },
    });
    await Promise.resolve();
    expect(sceneProbe.definitionCount).toBe(rocketCanvasDefinitions.length);
    expect(sceneProbe.resolveMount).toBeTypeOf("function");

    runtime.stop();
    await expect(ready).rejects.toMatchObject({ code: "invalid_lifecycle_state" });
    expect(sceneProbe.cleanupCount).toBe(1);
    sceneProbe.resolveMount?.();
    await Promise.resolve();
    await Promise.resolve();
    expect(sceneProbe.cleanupCount).toBe(1);
    expect(runtime.lifecycleState).toBe("stopped");
  });
});
