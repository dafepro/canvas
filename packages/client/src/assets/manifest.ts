import type { CanvasDefinition, ItemDefinition } from "@canvas-physics/core";

export interface AssetFrame {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface AssetSourceDefinition {
  id: string;
  src: string;
  required: boolean;
}

export interface AssetTextureDefinition {
  id: string;
  sourceId: string;
  frame?: AssetFrame;
}

/** Consumer-owned, versioned art inputs. Version 1 is an exact contract. */
export interface AssetManifest {
  schemaVersion: 1;
  id: string;
  revision: string;
  sources: AssetSourceDefinition[];
  textures: AssetTextureDefinition[];
}

export class AssetManifestError extends Error {
  readonly problems: readonly string[];

  constructor(problems: string[]) {
    super(`Invalid asset manifest:\n${problems.map((problem) => `- ${problem}`).join("\n")}`);
    this.name = "AssetManifestError";
    this.problems = Object.freeze([...problems]);
  }
}

export function assertAssetManifest(manifest: AssetManifest): void {
  const problems: string[] = [];
  if ((manifest as { schemaVersion?: unknown }).schemaVersion !== 1) {
    problems.push(`unsupported schemaVersion '${String((manifest as { schemaVersion?: unknown }).schemaVersion)}'`);
  }
  if (!manifest.id?.trim()) problems.push("id must be non-empty");
  if (!manifest.revision?.trim()) problems.push("revision must be non-empty");

  const sourceIds = new Set<string>();
  for (const [index, source] of (manifest.sources ?? []).entries()) {
    const path = `sources[${index}]`;
    if (!source.id?.trim()) problems.push(`${path}.id must be non-empty`);
    else if (sourceIds.has(source.id)) problems.push(`duplicate source id '${source.id}'`);
    else sourceIds.add(source.id);
    if (!source.src?.trim()) problems.push(`${path}.src must be non-empty`);
    if (typeof source.required !== "boolean") problems.push(`${path}.required must be boolean`);
  }

  const textureIds = new Set<string>();
  for (const [index, texture] of (manifest.textures ?? []).entries()) {
    const path = `textures[${index}]`;
    if (!texture.id?.trim()) problems.push(`${path}.id must be non-empty`);
    else if (textureIds.has(texture.id)) problems.push(`duplicate texture id '${texture.id}'`);
    else textureIds.add(texture.id);
    if (!sourceIds.has(texture.sourceId)) {
      problems.push(`${path} references unknown source '${texture.sourceId}'`);
    }
    if (texture.frame) {
      const { x, y, width, height } = texture.frame;
      if (!Number.isFinite(x) || x < 0) problems.push(`${path}.frame.x must be finite and non-negative`);
      if (!Number.isFinite(y) || y < 0) problems.push(`${path}.frame.y must be finite and non-negative`);
      if (!Number.isFinite(width) || width <= 0) problems.push(`${path}.frame.width must be finite and positive`);
      if (!Number.isFinite(height) || height <= 0) problems.push(`${path}.frame.height must be finite and positive`);
    }
  }

  if (problems.length > 0) throw new AssetManifestError(problems);
}

/** Returns definition references that have no matching logical texture. */
export function validateAssetReferences(
  manifest: AssetManifest,
  canvas: CanvasDefinition,
  definitions: ItemDefinition[],
): string[] {
  assertAssetManifest(manifest);
  const known = new Set(manifest.textures.map((texture) => texture.id));
  const missing: string[] = [];
  if (canvas.backgroundAssetId && !known.has(canvas.backgroundAssetId)) {
    missing.push(`canvas background references unknown texture '${canvas.backgroundAssetId}'`);
  }
  for (const definition of definitions) {
    const visual = definition.visual;
    if (visual.spriteId && !known.has(visual.spriteId)) {
      missing.push(`definition '${definition.definitionId}' references unknown texture '${visual.spriteId}'`);
    }
    for (const [name, variant] of Object.entries(visual.variants ?? {})) {
      if (variant.spriteId && !known.has(variant.spriteId)) {
        missing.push(`definition '${definition.definitionId}' variant '${name}' references unknown texture '${variant.spriteId}'`);
      }
    }
    for (const [name, animation] of Object.entries(visual.animations ?? {})) {
      for (const frame of animation.frames) {
        if (!known.has(frame)) {
          missing.push(`definition '${definition.definitionId}' animation '${name}' references unknown texture '${frame}'`);
        }
      }
    }
  }
  return missing;
}
