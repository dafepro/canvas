import { Assets, Rectangle, Texture } from "pixi.js";
import type { AssetLoaderAdapter } from "./pipeline.js";

/** The browser adapter used by CanvasRuntime. Kept separate for test adapters. */
export const pixiAssetLoader: AssetLoaderAdapter<Texture> = {
  async load(url) {
    return Assets.load<Texture>(url);
  },
  frame(source, frame, id) {
    if (frame.x + frame.width > source.width || frame.y + frame.height > source.height) {
      throw new RangeError(
        `Texture '${id}' frame ${frame.x},${frame.y},${frame.width},${frame.height} exceeds source ${source.width}x${source.height}`,
      );
    }
    return new Texture({
      source: source.source,
      frame: new Rectangle(frame.x, frame.y, frame.width, frame.height),
      label: id,
    });
  },
};
