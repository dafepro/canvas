import type { ElevationComponent } from "../registry/components.js";
import type { EnvironmentSample } from "./field.js";

export interface ElevationStepResult {
  landed: boolean;
  impactSpeed: number;
}

/**
 * Spec 4.3. Elevation is a scalar channel outside the 2D rigid-body world. Do
 * not add a 3D engine to make top-down objects hop.
 */
export const stepElevation = (
  elevation: ElevationComponent,
  sample: EnvironmentSample,
  dt: number,
): ElevationStepResult => {
  if (!elevation.enabled) return { landed: false, impactSpeed: 0 };

  const groundZ = elevation.groundZ ?? 0;
  const wasAirborne = !elevation.grounded;

  // zGravity is the downward pull on the elevation channel. Z is height
  // above the ground plane, so the pull always reduces vz.
  elevation.vz -= sample.zGravity * dt;
  elevation.vz -= elevation.vz * sample.zDrag * dt;
  elevation.z += elevation.vz * dt;

  if (elevation.z > groundZ) {
    elevation.grounded = false;
    return { landed: false, impactSpeed: 0 };
  }

  const impactSpeed = Math.abs(elevation.vz);
  elevation.z = groundZ;
  const restitution = elevation.restitution ?? 0;
  if (restitution > 0 && impactSpeed > 0.5) {
    elevation.vz = -elevation.vz * restitution;
    elevation.grounded = false;
  } else {
    elevation.vz = 0;
    elevation.grounded = true;
  }
  return { landed: wasAirborne, impactSpeed };
};

/** Sprite scale for the current elevation, used by the renderer. */
export const elevationScale = (elevation: ElevationComponent): number =>
  1 + (elevation.scalePerZ ?? 0) * (elevation.z - (elevation.groundZ ?? 0));
