import type { CanvasConsumerError } from "../lifecycle.js";

interface PresentationFacts {
  simulationReady: boolean;
  presence?: ReadonlySet<string>;
  items?: ReadonlySet<string>;
  canonical?: ReadonlySet<string>;
}

/** Generation-consistent first-presentation readiness with sticky public completion. */
export class PresentationGate {
  private generation = 0;
  private facts: PresentationFacts = { simulationReady: false };
  private presentedValue = false;
  private authoritativeCurrentValue = false;
  private terminalError?: CanvasConsumerError;
  private readonly waiters = new Set<{
    resolve: () => void;
    reject: (error: CanvasConsumerError) => void;
  }>();

  get presented(): boolean {
    return this.presentedValue;
  }

  get authoritativeCurrent(): boolean {
    return this.authoritativeCurrentValue;
  }

  wait(): Promise<void> {
    if (this.presentedValue) return Promise.resolve();
    if (this.terminalError) return Promise.reject(this.terminalError);
    return new Promise<void>((resolve, reject) => {
      this.waiters.add({ resolve, reject });
    });
  }

  resetConnection(generation: number): void {
    if (generation < this.generation) return;
    this.generation = generation;
    this.facts = { simulationReady: false };
    this.authoritativeCurrentValue = false;
  }

  resetRole(generation: number): void {
    if (generation !== this.generation) return;
    this.facts = {
      simulationReady: false,
      presence: this.facts.presence,
      items: this.facts.items,
    };
    this.authoritativeCurrentValue = false;
  }

  markSimulationReady(generation: number): void {
    if (generation !== this.generation) return;
    this.facts.simulationReady = true;
    this.evaluate();
  }

  markPresence(generation: number, avatarIds: readonly string[]): void {
    if (generation !== this.generation) return;
    this.facts.presence = new Set(avatarIds);
    this.evaluate();
  }

  markItems(generation: number, itemIds: readonly string[]): void {
    if (generation !== this.generation) return;
    this.facts.items = new Set(itemIds);
    this.evaluate();
  }

  markCanonical(generation: number, entityIds: readonly string[]): void {
    if (generation !== this.generation) return;
    this.facts.canonical = new Set(entityIds);
    this.evaluate();
  }

  fail(error: CanvasConsumerError): void {
    if (this.terminalError || this.presentedValue) return;
    this.terminalError = error;
    for (const waiter of this.waiters) waiter.reject(error);
    this.waiters.clear();
  }

  private evaluate(): void {
    const { simulationReady, presence, items, canonical } = this.facts;
    if (!simulationReady || !presence || !items || !canonical) return;
    for (const id of presence) if (!canonical.has(id)) return;
    for (const id of items) if (!canonical.has(id)) return;
    this.authoritativeCurrentValue = true;
    if (this.presentedValue) return;
    this.presentedValue = true;
    for (const waiter of this.waiters) waiter.resolve();
    this.waiters.clear();
  }
}
