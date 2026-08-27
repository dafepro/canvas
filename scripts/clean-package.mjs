import { rmSync } from "node:fs";
import { dirname, resolve } from "node:path";

const packageRoot = resolve(process.cwd());
const output = resolve(packageRoot, "dist");

if (dirname(output) !== packageRoot) {
  throw new Error(`refusing to clean output outside package root: ${output}`);
}

rmSync(output, { force: true, recursive: true });
