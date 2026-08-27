import { spawn } from "node:child_process";
import { mkdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const scriptPath = fileURLToPath(import.meta.url);
const workspaceRoot = path.resolve(path.dirname(scriptPath), "..");
const releaseManifest = JSON.parse(
  readFileSync(path.join(workspaceRoot, "package.json"), "utf8"),
);

const examples = Object.freeze({
  "soccer-lounge": 8082,
  "item-playground": 8083,
  "linked-rooms": 8084,
  "basketball-arena": 8085,
});

const example = process.argv[2];
if (!(example in examples)) {
  console.error(
    `Usage: node scripts/run-example-server.mjs <${Object.keys(examples).join("|")}> [--print-config]`,
  );
  process.exitCode = 2;
} else {
  const exampleRoot = path.join(workspaceRoot, "examples", example);
  const configuredDataDir = process.env.CANVAS_EXAMPLE_DATA_DIR;
  const config = {
    example,
    releaseVersion: releaseManifest.version,
    address: `:${examples[example]}`,
    canvasesDir: path.join(exampleRoot, "server", "canvases"),
    definitionsDir: path.join(exampleRoot, "server", "definitions"),
    dataDir: configuredDataDir
      ? path.resolve(configuredDataDir)
      : path.join(exampleRoot, ".data", `v${releaseManifest.version}`),
  };

  if (process.argv.includes("--print-config")) {
    process.stdout.write(`${JSON.stringify(config)}\n`);
  } else {
    mkdirSync(config.dataDir, { recursive: true });
    console.log(
      `[canvas example] ${config.example}@${config.releaseVersion} using ${config.dataDir}`,
    );
    const child = spawn(
      "go",
      [
        "-C",
        path.join(workspaceRoot, "server"),
        "run",
        "./cmd/canvasd",
        "-addr",
        config.address,
        "-canvases",
        config.canvasesDir,
        "-definitions",
        config.definitionsDir,
        "-data-dir",
        config.dataDir,
      ],
      { cwd: workspaceRoot, stdio: "inherit" },
    );
    const stop = () => child.kill("SIGTERM");
    process.once("SIGINT", stop);
    process.once("SIGTERM", stop);
    child.once("error", (error) => {
      console.error(`[canvas example] failed to start canvasd: ${error.message}`);
      process.exitCode = 1;
    });
    child.once("exit", (code) => {
      process.exitCode = code ?? 0;
    });
  }
}
