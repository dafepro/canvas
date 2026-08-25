export type SessionTimeout = ReturnType<typeof setTimeout>;
export type SessionInterval = ReturnType<typeof setInterval>;

/** Internal scheduling port so transition tests never depend on wall time. */
export interface SessionClock {
  now(): number;
  setTimeout(callback: () => void, delayMs: number): SessionTimeout;
  clearTimeout(timeout: SessionTimeout): void;
  setInterval(callback: () => void, everyMs: number): SessionInterval;
  clearInterval(interval: SessionInterval): void;
}

export const systemSessionClock: SessionClock = Object.freeze({
  now: () => Date.now(),
  setTimeout: (callback: () => void, delayMs: number) => setTimeout(callback, delayMs),
  clearTimeout: (timeout: SessionTimeout) => clearTimeout(timeout),
  setInterval: (callback: () => void, everyMs: number) => setInterval(callback, everyMs),
  clearInterval: (interval: SessionInterval) => clearInterval(interval),
});
