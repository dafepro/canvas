export type SessionTimeout = ReturnType<typeof setTimeout>;

/** Internal scheduling port so transition tests never depend on wall time. */
export interface SessionClock {
  now(): number;
  setTimeout(callback: () => void, delayMs: number): SessionTimeout;
  clearTimeout(timeout: SessionTimeout): void;
}

export const systemSessionClock: SessionClock = Object.freeze({
  now: () => Date.now(),
  setTimeout: (callback: () => void, delayMs: number) => setTimeout(callback, delayMs),
  clearTimeout: (timeout: SessionTimeout) => clearTimeout(timeout),
});
