import type { SimulationRequest, SimulationResponse } from "../simulation/messages.js";

export type SimulationWorkerConformanceIssueCode =
  | "fixture_failed"
  | "listener_failed"
  | "scenario_required"
  | "initialization_failed"
  | "snapshot_failed"
  | "scenario_failed"
  | "stop_failed";

export interface SimulationWorkerConformanceIssue {
  readonly code: SimulationWorkerConformanceIssueCode;
  readonly message: string;
  readonly scenario?: string;
}

export interface SimulationWorkerConformanceReport {
  readonly ok: boolean;
  readonly checksRun: number;
  readonly scenariosRun: number;
  readonly issues: readonly Readonly<SimulationWorkerConformanceIssue>[];
}

/** Minimal wrapper around the application-owned worker bundle under test. */
export interface SimulationWorkerConformanceChannel {
  postMessage(request: SimulationRequest): void;
  onMessage(handler: (response: SimulationResponse) => void): () => void;
  terminate(): void | Promise<void>;
}

export interface SimulationWorkerConformanceController {
  readonly responses: readonly Readonly<SimulationResponse>[];
  send(request: SimulationRequest): void;
  waitFor(
    predicate: (response: Readonly<SimulationResponse>) => boolean,
    failureMessage: string,
  ): Promise<Readonly<SimulationResponse>>;
}

export interface SimulationWorkerConformanceScenario {
  readonly name: string;
  /** Exercise one application behavior through data-only worker messages. */
  exercise(controller: SimulationWorkerConformanceController): void | Promise<void>;
}

export interface SimulationWorkerConformanceFixture {
  /** Construct the actual application worker entry or its production-equivalent wrapper. */
  create(): SimulationWorkerConformanceChannel | Promise<SimulationWorkerConformanceChannel>;
  readonly init: Extract<SimulationRequest, { type: "init" }>;
  readonly scenarios: readonly SimulationWorkerConformanceScenario[];
  /** Maximum wait for one expected response. Defaults to 10 seconds. */
  readonly timeoutMs?: number;
}

/**
 * Verifies that an application-owned worker boots Canvas, exchanges data-only
 * messages, runs representative custom behavior, snapshots, and stops cleanly.
 */
export const runSimulationWorkerConformance = async (
  fixture: SimulationWorkerConformanceFixture,
): Promise<Readonly<SimulationWorkerConformanceReport>> => {
  const issues: SimulationWorkerConformanceIssue[] = [];
  const timeoutMs = fixture.timeoutMs ?? 10_000;
  let checksRun = 0;
  let scenariosRun = 0;
  const add = (
    code: SimulationWorkerConformanceIssueCode,
    message: string,
    scenario?: string,
  ): void => { issues.push(Object.freeze({ code, message, scenario })); };

  if (fixture.scenarios.length === 0) {
    add("scenario_required", "at least one application-owned worker scenario is required");
  }

  let channel: SimulationWorkerConformanceChannel;
  try {
    channel = await fixture.create();
  } catch (cause) {
    add("fixture_failed", describeFailure("worker fixture creation failed", cause));
    return freezeReport(checksRun, scenariosRun, issues);
  }

  const responses: SimulationResponse[] = [];
  let removedListenerCalls = 0;
  let unsubscribe = (): void => {};
  try {
    unsubscribe = channel.onMessage((response) => responses.push(response));
    const remove = channel.onMessage(() => { removedListenerCalls++; });
    remove();
  } catch (cause) {
    add("listener_failed", describeFailure("worker listener registration failed", cause));
    try { await channel.terminate(); } catch { /* The listener issue is primary. */ }
    return freezeReport(checksRun, scenariosRun, issues);
  }

  const waitFor = async (
    predicate: (response: Readonly<SimulationResponse>) => boolean,
    failureMessage: string,
    fromIndex = 0,
  ): Promise<Readonly<SimulationResponse>> => {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      for (let index = fromIndex; index < responses.length; index++) {
        const response = responses[index]!;
        if (response.type === "error") throw new Error(`worker error: ${response.message}`);
        if (predicate(response)) return response;
      }
      await nextTurn();
    }
    throw new Error(failureMessage);
  };

  const controller: SimulationWorkerConformanceController = {
    get responses() { return Object.freeze(responses.map((response) => Object.freeze(response))); },
    send: (request) => channel.postMessage(request),
    waitFor: (predicate, failureMessage) => waitFor(predicate, failureMessage),
  };

  const check = async (
    code: Exclude<SimulationWorkerConformanceIssueCode, "fixture_failed" | "listener_failed" | "scenario_required">,
    exercise: () => void | Promise<void>,
    scenario?: string,
  ): Promise<boolean> => {
    checksRun++;
    try {
      await exercise();
      return true;
    } catch (cause) {
      add(code, describeFailure(code.replaceAll("_", " "), cause), scenario);
      return false;
    }
  };

  let initialized = false;
  try {
    initialized = await check("initialization_failed", async () => {
      const fromIndex = responses.length;
      channel.postMessage(fixture.init);
      await waitFor((response) => response.type === "ready", "worker did not become ready", fromIndex);
      assert(removedListenerCalls === 0, "an unsubscribed worker listener was called");
    });

    await check("snapshot_failed", async () => {
      assert(initialized, "snapshot requires successful worker initialization");
      const fromIndex = responses.length;
      channel.postMessage({
        type: "requestSnapshot",
        final: false,
        sceneRevision: 73,
        hostEpoch: 11,
      });
      const response = await waitFor(
        (candidate) => candidate.type === "snapshot",
        "worker did not return a snapshot",
        fromIndex,
      );
      assert(response.type === "snapshot", "worker returned the wrong response type");
      assert(response.final === false, "worker changed the snapshot final flag");
      assert(response.snapshot.sceneRevision === 73, "worker changed the snapshot scene revision");
      assert(response.snapshot.hostEpoch === 11, "worker changed the snapshot host epoch");
    });

    for (const scenario of fixture.scenarios) {
      const passed = await check(
        "scenario_failed",
        async () => {
          const before = responses.length;
          await scenario.exercise(controller);
          for (let index = before; index < responses.length; index++) {
            const response = responses[index]!;
            if (response.type === "error") throw new Error(`worker error: ${response.message}`);
          }
        },
        scenario.name,
      );
      if (passed) scenariosRun++;
    }

    await check("stop_failed", async () => {
      if (initialized) {
        channel.postMessage({ type: "stop" });
        const countAfterStop = responses.length;
        await new Promise((resolve) => setTimeout(resolve, 20));
        assert(responses.length === countAfterStop, "worker kept publishing after stop");
      }
      await channel.terminate();
    });
  } finally {
    unsubscribe();
    if (checksRun === 0 || issues.some(({ code }) => code === "stop_failed")) {
      try { await channel.terminate(); } catch { /* The reported issue is sufficient. */ }
    }
  }

  return freezeReport(checksRun, scenariosRun, issues);
};

const assert: (condition: unknown, message: string) => asserts condition = (
  condition,
  message,
) => {
  if (!condition) throw new Error(message);
};

const nextTurn = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 2));

const describeFailure = (prefix: string, cause: unknown): string =>
  `${prefix}: ${cause instanceof Error ? cause.message : String(cause)}`;

const freezeReport = (
  checksRun: number,
  scenariosRun: number,
  issues: SimulationWorkerConformanceIssue[],
): Readonly<SimulationWorkerConformanceReport> => Object.freeze({
  ok: issues.length === 0,
  checksRun,
  scenariosRun,
  issues: Object.freeze(issues),
});
