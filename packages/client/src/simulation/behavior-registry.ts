import {
  BehaviorRegistry,
  KickableBehavior,
  PortalBehavior,
  RoomTravelBehavior,
  RocketBehavior,
  type ItemBehavior,
} from "@canvas-physics/core";

/**
 * Builds the behavior registry used by a simulation kernel. Application
 * behaviors are developer-authored imports in the worker bundle; behavior
 * functions never cross the worker message boundary.
 */
export const createSimulationBehaviorRegistry = (
  applicationBehaviors: readonly ItemBehavior<any, any>[] = [],
): BehaviorRegistry => {
  const registry = new BehaviorRegistry()
    .register(RocketBehavior)
    .register(KickableBehavior)
    .register(PortalBehavior)
    .register(RoomTravelBehavior);
  for (const behavior of applicationBehaviors) registry.register(behavior);
  return registry;
};
