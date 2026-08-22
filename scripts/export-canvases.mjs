// Exports the canvas definitions from TypeScript to the JSON files that
// canvasd loads, so the client and the server share one source of truth.
import { build } from "esbuild";
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const entry = resolve(root, "packages/client/src/definitions/rocket-canvas.ts");
const outFile = resolve(root, "node_modules/.cache/canvas-definitions.mjs");
const outDir = resolve(root, "server/canvases");
const definitionDir = resolve(root, "server/definitions");

mkdirSync(dirname(outFile), { recursive: true });
await build({
  entryPoints: [entry],
  outfile: outFile,
  bundle: true,
  format: "esm",
  platform: "node",
  target: "node20",
  logLevel: "warning",
});

const module = await import(`file://${outFile}`);
mkdirSync(outDir, { recursive: true });
mkdirSync(definitionDir, { recursive: true });

const canvases = Object.entries(module).filter(
  ([, value]) => value && typeof value === "object" && "staticGeometry" in value,
);

for (const [name, canvas] of canvases) {
  const file = resolve(outDir, `${canvas.id}.json`);
  writeFileSync(file, `${JSON.stringify(canvas, null, 2)}\n`);
  console.log(`wrote ${file} from ${name}`);
}

const definitions = Object.entries(module).filter(
  ([, value]) => value && typeof value === "object" && !Array.isArray(value) && "definitionId" in value,
);

const schemaFor = (value) => {
  if (value === null) return { type: "null" };
  if (Array.isArray(value)) {
    return { type: "array", items: schemaFor(value[0] ?? null) };
  }
  if (typeof value === "object") {
    const entries = Object.entries(value);
    return {
      type: "object",
      properties: Object.fromEntries(entries.map(([key, child]) => [key, schemaFor(child)])),
      required: entries.map(([key]) => key),
      additionalProperties: false,
    };
  }
  if (typeof value === "number" || typeof value === "string" || typeof value === "boolean") {
    return { type: typeof value };
  }
  throw new Error(`cannot infer config schema for ${typeof value}`);
};

for (const [name, definition] of definitions) {
  const file = resolve(definitionDir, `${definition.definitionId}.json`);
  const exported = {
    ...definition,
    configSchema: definition.configSchema ?? schemaFor(definition.defaultConfig ?? {}),
  };
  writeFileSync(file, `${JSON.stringify(exported, null, 2)}\n`);
  console.log(`wrote ${file} from ${name}`);
}

rmSync(outFile, { force: true });
if (canvases.length === 0) {
  console.error("no canvas definitions found");
  process.exit(1);
}
if (definitions.length === 0) {
  console.error("no item definitions found");
  process.exit(1);
}
