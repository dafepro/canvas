/** Schema versions for durable data. Bump when a shape changes. */
export const SCHEMA_VERSIONS = {
  canvasDefinition: 1,
  itemDefinition: 1,
  itemInstance: 1,
  snapshot: 1,
} as const;

/** Wire protocol version. A client with a different major value is refused. */
export const PROTOCOL_VERSION = 1;

export type Migration<T = unknown> = (input: T) => T;

/**
 * Migrations for persistent behavior state (spec 8.4). A behavior that changes
 * its persisted shape must register a migration for each version step.
 */
export class MigrationChain<T = unknown> {
  private readonly steps = new Map<number, Migration<T>>();

  constructor(readonly currentVersion: number) {}

  /** Register the function that upgrades `fromVersion` to `fromVersion + 1`. */
  step(fromVersion: number, migrate: Migration<T>): this {
    this.steps.set(fromVersion, migrate);
    return this;
  }

  migrate(value: T, fromVersion: number): T {
    if (fromVersion > this.currentVersion) {
      throw new Error(
        `state version ${fromVersion} is newer than supported ${this.currentVersion}`,
      );
    }
    let out = value;
    for (let v = fromVersion; v < this.currentVersion; v++) {
      const step = this.steps.get(v);
      if (!step) {
        throw new Error(`no migration registered from state version ${v}`);
      }
      out = step(out);
    }
    return out;
  }
}
