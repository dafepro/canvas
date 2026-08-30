import {
  assertAssetManifest,
  type AssetFrame,
  type AssetManifest,
  type AssetSourceDefinition,
} from "./manifest.js";

export interface AssetLoaderAdapter<Texture> {
  load(url: string): Promise<Texture>;
  frame(source: Texture, frame: AssetFrame, id: string): Texture;
}

export type AssetSourceStatus = "pending" | "loaded" | "warning" | "failed";

export interface AssetSourceProgress {
  sourceId: string;
  required: boolean;
  status: AssetSourceStatus;
}

export interface AssetProgress {
  settled: number;
  total: number;
  ratio: number;
  sources: readonly Readonly<AssetSourceProgress>[];
}

export interface AssetWarning {
  sourceId: string;
  message: string;
  cause: unknown;
}

export interface AssetFailure {
  sourceId: string;
  cause: unknown;
}

export interface AssetPreloadOptions<Texture> {
  adapter: AssetLoaderAdapter<Texture>;
  onProgress?: (progress: Readonly<AssetProgress>) => void;
  onWarning?: (warning: Readonly<AssetWarning>) => void;
}

export class AssetLoadError extends Error {
  readonly failures: readonly AssetFailure[];

  constructor(failures: AssetFailure[]) {
    super(`Required assets failed to load: ${failures.map((failure) => failure.sourceId).join(", ")}`);
    this.name = "AssetLoadError";
    this.failures = Object.freeze(failures.map((failure) => Object.freeze({ ...failure })));
  }
}

export class LoadedAssetBundle<Texture> {
  readonly warnings: readonly AssetWarning[];

  constructor(
    readonly manifest: AssetManifest,
    private readonly textures: ReadonlyMap<string, Texture>,
    warnings: AssetWarning[],
  ) {
    this.warnings = Object.freeze(warnings.map((warning) => Object.freeze({ ...warning })));
  }

  texture(id: string): Texture | undefined {
    return this.textures.get(id);
  }

  has(id: string): boolean {
    return this.textures.has(id);
  }
}

export function versionAssetUrl(src: string, revision: string): string {
  if (src.startsWith("data:") || src.startsWith("blob:")) return src;
  const hashIndex = src.indexOf("#");
  const hash = hashIndex >= 0 ? src.slice(hashIndex) : "";
  const withoutHash = hashIndex >= 0 ? src.slice(0, hashIndex) : src;
  const separator = withoutHash.includes("?") ? "&" : "?";
  return `${withoutHash}${separator}canvasAssetRevision=${encodeURIComponent(revision)}${hash}`;
}

export async function preloadAssetManifest<Texture>(
  manifest: AssetManifest,
  options: AssetPreloadOptions<Texture>,
): Promise<LoadedAssetBundle<Texture>> {
  assertAssetManifest(manifest);
  const sources = new Map<string, Texture>();
  const failures: AssetFailure[] = [];
  const warnings: AssetWarning[] = [];
  let settled = 0;
  const sourceProgress: AssetSourceProgress[] = manifest.sources.map((source) => ({
    sourceId: source.id,
    required: source.required,
    status: "pending",
  }));
  const publishProgress = () => options.onProgress?.(Object.freeze({
    settled,
    total: manifest.sources.length,
    ratio: manifest.sources.length === 0 ? 1 : settled / manifest.sources.length,
    sources: Object.freeze(sourceProgress.map((source) => Object.freeze({ ...source }))),
  }));
  publishProgress();

  const results = await Promise.all(
    manifest.sources.map(async (source, index) => {
      try {
        const value = (await options.adapter.load(
          versionAssetUrl(source.src, manifest.revision),
        )) as Texture;
        sourceProgress[index]!.status = "loaded";
        return { ok: true, source, value } as const;
      } catch (cause) {
        sourceProgress[index]!.status = source.required ? "failed" : "warning";
        return { ok: false, source, cause } as const;
      } finally {
        settled += 1;
        publishProgress();
      }
    }),
  );

  for (const result of results) {
    if (result.ok) {
      sources.set(result.source.id, result.value);
    } else {
      recordFailure(result.source, result.cause, failures, warnings, options.onWarning);
    }
  }
  if (failures.length > 0) throw new AssetLoadError(failures);

  const textures = new Map<string, Texture>();
  const sourceById = new Map(manifest.sources.map((source) => [source.id, source]));
  for (const texture of manifest.textures) {
    if (!sources.has(texture.sourceId)) continue;
    const source = sources.get(texture.sourceId) as Texture;
    try {
      textures.set(
        texture.id,
        texture.frame ? options.adapter.frame(source, texture.frame, texture.id) : source,
      );
    } catch (cause) {
      const sourceDefinition = sourceById.get(texture.sourceId)!;
      recordFailure(sourceDefinition, cause, failures, warnings, options.onWarning);
    }
  }
  if (failures.length > 0) throw new AssetLoadError(failures);

  return new LoadedAssetBundle(manifest, textures, warnings);
}

function recordFailure(
  source: AssetSourceDefinition,
  cause: unknown,
  failures: AssetFailure[],
  warnings: AssetWarning[],
  onWarning?: (warning: Readonly<AssetWarning>) => void,
): void {
  if (source.required) {
    failures.push({ sourceId: source.id, cause });
    return;
  }
  const warning = Object.freeze({
    sourceId: source.id,
    message: `Optional asset source '${source.id}' could not be loaded`,
    cause,
  });
  warnings.push(warning);
  onWarning?.(warning);
}
