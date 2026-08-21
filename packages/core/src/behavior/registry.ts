import type { ItemBehavior } from "./behavior.js";

/**
 * Behavior types are developer-authored and registered at build time. There is
 * no user scripting (spec 1.1).
 */
export class BehaviorRegistry {
  private readonly behaviors = new Map<string, ItemBehavior<any, any>>();

  register<Config, State>(behavior: ItemBehavior<Config, State>): this {
    if (this.behaviors.has(behavior.behaviorType)) {
      throw new Error(`behavior type ${behavior.behaviorType} already registered`);
    }
    this.behaviors.set(behavior.behaviorType, behavior);
    return this;
  }

  get<Config = unknown, State = unknown>(
    behaviorType: string,
  ): ItemBehavior<Config, State> | undefined {
    return this.behaviors.get(behaviorType) as
      | ItemBehavior<Config, State>
      | undefined;
  }

  require<Config = unknown, State = unknown>(
    behaviorType: string,
  ): ItemBehavior<Config, State> {
    const behavior = this.get<Config, State>(behaviorType);
    if (!behavior) throw new Error(`unknown behavior type ${behaviorType}`);
    return behavior;
  }

  has(behaviorType: string): boolean {
    return this.behaviors.has(behaviorType);
  }

  types(): string[] {
    return [...this.behaviors.keys()].sort();
  }
}
