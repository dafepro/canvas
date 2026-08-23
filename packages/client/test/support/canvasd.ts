import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { createServer } from "node:net";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const repoRoot = path.resolve(import.meta.dirname, "../../../..");
const serverDir = path.join(repoRoot, "server");

export interface Canvasd {
  /** Base URL, such as http://127.0.0.1:53412. */
  url: string;
  stop(): void;
}

export const createCanvasdDataDir = (): string =>
  mkdtempSync(path.join(tmpdir(), "canvasd-data-"));

/** True when the Go toolchain is present, so the test can build canvasd. */
export const goAvailable = (): boolean => {
  try {
    execFileSync("go", ["version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
};

const freePort = (): Promise<number> =>
  new Promise((resolve, reject) => {
    const probe = createServer();
    probe.on("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const address = probe.address();
      if (typeof address === "string" || address === null) {
        probe.close();
        reject(new Error("no port"));
        return;
      }
      const { port } = address;
      probe.close(() => resolve(port));
    });
  });

const waitForHealth = async (url: string, deadlineMs: number): Promise<void> => {
  const until = Date.now() + deadlineMs;
  while (Date.now() < until) {
    try {
      const response = await fetch(`${url}/healthz`);
      if (response.ok) return;
    } catch {
      // The process is still starting.
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`canvasd did not answer /healthz at ${url}`);
};

/**
 * Builds and starts one canvasd process for a test. The test owns the process,
 * so it must call `stop`.
 */
export const startCanvasd = async (
  options: { dataDir?: string } = {},
): Promise<Canvasd> => {
  const binaryName = process.platform === "win32" ? "canvasd.exe" : "canvasd";
  const binary = path.join(mkdtempSync(path.join(tmpdir(), "canvasd-")), binaryName);
  execFileSync("go", ["build", "-o", binary, "./cmd/canvasd"], {
    cwd: serverDir,
    stdio: "pipe",
  });

  const port = await freePort();
  const child: ChildProcess = spawn(
    binary,
    [
      "-addr",
      `127.0.0.1:${port}`,
      "-canvases",
      path.join(serverDir, "canvases"),
      "-data-dir",
      options.dataDir ?? createCanvasdDataDir(),
      "-log-level",
      "error",
    ],
    { cwd: serverDir, stdio: ["ignore", "pipe", "pipe"] },
  );
  child.stderr?.on("data", (chunk: Buffer) => {
    process.stderr.write(`canvasd: ${chunk.toString()}`);
  });

  const url = `http://127.0.0.1:${port}`;
  try {
    await waitForHealth(url, 15_000);
  } catch (error) {
    child.kill("SIGKILL");
    throw error;
  }

  return {
    url,
    stop: () => {
      child.kill("SIGTERM");
    },
  };
};

/** Polls `condition` until it is true, or fails after `timeoutMs`. */
export const waitFor = async (
  label: string,
  condition: () => boolean | Promise<boolean>,
  timeoutMs = 10_000,
): Promise<void> => {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    if (await condition()) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`timed out waiting for ${label}`);
};
