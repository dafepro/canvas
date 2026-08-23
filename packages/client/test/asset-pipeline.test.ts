import { describe, expect, it, vi } from "vitest";
import type { CanvasDefinition, ItemDefinition } from "@canvas-physics/core";
import {
  AssetLoadError,
  AssetManifestError,
  preloadAssetManifest,
  validateAssetReferences,
  versionAssetUrl,
  type AssetLoaderAdapter,
  type AssetManifest,
} from "../src/assets/index.js";
import { CanvasRuntime } from "../src/runtime/canvas-runtime.js";
import { CanvasConsumerError } from "../src/runtime/lifecycle.js";
import { SimulationDriver } from "../src/simulation/driver.js";
import { emptyTraffic, type RoomTransport } from "../src/net/transport.js";

const manifest: AssetManifest = {
  schemaVersion: 1,
  id: "test-art",
  revision: "rev 2",
  sources: [
    { id: "field", src: "/field.svg?theme=night#art", required: true },
    { id: "atlas", src: "/atlas.png", required: true },
  ],
  textures: [
    { id: "field", sourceId: "field" },
    {
      id: "ball.idle",
      sourceId: "atlas",
      frame: { x: 0, y: 0, width: 64, height: 64 },
    },
  ],
};

describe("asset manifest", () => {
  it("rejects ambiguous and invalid manifests before loading", async () => {
    const invalid = {
      ...manifest,
      sources: [...manifest.sources, manifest.sources[0]],
      textures: [
        ...manifest.textures,
        {
          id: "bad-frame",
          sourceId: "missing",
          frame: { x: -1, y: 0, width: 0, height: 12 },
        },
      ],
    } satisfies AssetManifest;

    await expect(
      preloadAssetManifest(invalid, { adapter: fakeAdapter() }),
    ).rejects.toBeInstanceOf(AssetManifestError);
  });

  it("adds the deterministic revision without losing query strings or hashes", () => {
    expect(versionAssetUrl(manifest.sources[0].src, manifest.revision)).toBe(
      "/field.svg?theme=night&canvasAssetRevision=rev%202#art",
    );
  });

  it("loads each source once, creates atlas frames, and reports progress", async () => {
    const adapter = fakeAdapter();
    const progress = vi.fn();
    const bundle = await preloadAssetManifest(manifest, { adapter, onProgress: progress });

    expect(adapter.load).toHaveBeenCalledTimes(2);
    expect(bundle.texture("field")).toBe(
      "source:/field.svg?theme=night&canvasAssetRevision=rev%202#art",
    );
    expect(bundle.texture("ball.idle")).toBe(
      "source:/atlas.png?canvasAssetRevision=rev%202@[0,0,64,64]",
    );
    expect(bundle.warnings).toEqual([]);
    expect(progress).toHaveBeenLastCalledWith({ loaded: 2, total: 2, ratio: 1 });
  });

  it("warns and falls back for optional failures but rejects required failures", async () => {
    const optionalFailure: AssetManifest = {
      ...manifest,
      sources: [
        manifest.sources[0],
        { id: "atlas", src: "/missing.png", required: false },
      ],
    };
    const warning = vi.fn();
    const adapter = fakeAdapter("missing.png");
    const bundle = await preloadAssetManifest(optionalFailure, {
      adapter,
      onWarning: warning,
    });

    expect(bundle.texture("ball.idle")).toBeUndefined();
    expect(bundle.warnings).toHaveLength(1);
    expect(warning).toHaveBeenCalledWith(bundle.warnings[0]);

    await expect(
      preloadAssetManifest(
        {
          ...optionalFailure,
          sources: optionalFailure.sources.map((source) => ({ ...source, required: true })),
        },
        { adapter },
      ),
    ).rejects.toBeInstanceOf(AssetLoadError);
  });

  it("reports every definition reference not supplied by the manifest", () => {
    const canvas = {
      backgroundAssetId: "missing.field",
    } as CanvasDefinition;
    const definitions = [
      {
        definitionId: "ball",
        visual: {
          spriteId: "ball.idle",
          size: { width: 2, height: 2 },
          variants: { scored: { spriteId: "missing.variant" } },
          animations: {
            kick: { frames: ["ball.idle", "missing.frame"], fps: 12, loop: false },
          },
        },
      } as ItemDefinition,
    ];

    expect(validateAssetReferences(manifest, canvas, definitions)).toEqual([
      "canvas background references unknown texture 'missing.field'",
      "definition 'ball' variant 'scored' references unknown texture 'missing.variant'",
      "definition 'ball' animation 'kick' references unknown texture 'missing.frame'",
    ]);
  });

  it("finishes required preloading before opening the room connection", async () => {
    let finishLoad!: (texture: string) => void;
    const adapter: AssetLoaderAdapter<string> = {
      load: vi.fn(() => new Promise<string>((resolve) => { finishLoad = resolve; })),
      frame: (source) => source,
    };
    const connect = vi.fn(async () => undefined);
    const transport: RoomTransport = {
      connect,
      sendReliable: vi.fn(),
      sendRealtime: vi.fn(),
      onMessage: () => () => undefined,
      onStatus: () => () => undefined,
      status: "idle",
      traffic: emptyTraffic(),
      close: vi.fn(),
    };
    const runtime = new CanvasRuntime({
      roomId: "asset-gate",
      serverUrl: "http://unused.test",
      mount: {} as HTMLElement,
      definitions: [],
      transport,
      driver: SimulationDriver.local(),
      assets: {
        schemaVersion: 1,
        id: "gate",
        revision: "1",
        sources: [{ id: "required", src: "/required.png", required: true }],
        textures: [{ id: "required", sourceId: "required" }],
      },
      assetLoader: adapter as AssetLoaderAdapter<import("pixi.js").Texture>,
    });

    const started = runtime.start();
    await Promise.resolve();
    expect(connect).not.toHaveBeenCalled();
    finishLoad("texture");
    await started;
    expect(connect).toHaveBeenCalledOnce();
    runtime.stop();
  });

  it("reports required preload failures through the typed consumer error model", async () => {
    const connect = vi.fn(async () => undefined);
    const onError = vi.fn();
    const runtime = new CanvasRuntime({
      roomId: "asset-failure",
      serverUrl: "http://unused.test",
      mount: {} as HTMLElement,
      definitions: [],
      transport: {
        connect,
        sendReliable: vi.fn(),
        sendRealtime: vi.fn(),
        onMessage: () => () => undefined,
        onStatus: () => () => undefined,
        status: "idle",
        traffic: emptyTraffic(),
        close: vi.fn(),
      },
      driver: SimulationDriver.local(),
      assets: {
        schemaVersion: 1,
        id: "required-failure",
        revision: "1",
        sources: [{ id: "required", src: "/missing.png", required: true }],
        textures: [{ id: "required", sourceId: "required" }],
      },
      assetLoader: fakeAdapter("missing.png") as AssetLoaderAdapter<import("pixi.js").Texture>,
      onError,
    });

    await expect(runtime.start()).rejects.toMatchObject({
      code: "asset_preload_failed",
      source: "assets",
      recoverable: false,
    });
    expect(onError).toHaveBeenCalledOnce();
    expect(onError.mock.calls[0][0]).toBeInstanceOf(CanvasConsumerError);
    expect(connect).not.toHaveBeenCalled();
    expect(runtime.lifecycleState).toBe("stopped");
  });
});

function fakeAdapter(failingUrl?: string): AssetLoaderAdapter<string> & {
  load: ReturnType<typeof vi.fn>;
} {
  return {
    load: vi.fn(async (url: string) => {
      if (failingUrl && url.includes(failingUrl)) throw new Error("not found");
      return `source:${url}`;
    }),
    frame: (source, frame) =>
      `${source}@[${frame.x},${frame.y},${frame.width},${frame.height}]`,
  };
}
