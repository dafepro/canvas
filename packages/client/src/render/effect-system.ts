import { Container, Graphics, Text } from "pixi.js";
import type { EffectEmission } from "@canvas-physics/core";
import type { RenderEntity } from "../simulation/messages.js";
import type { Camera } from "./camera.js";

interface Particle {
  display: Graphics;
  x: number;
  y: number;
  vx: number;
  vy: number;
  lifeMs: number;
  totalMs: number;
}

interface Continuous {
  entityId: string;
  effect: string;
  spawnAccumulatorMs: number;
}

export interface MotionTrailOptions {
  effect: string;
  kinds?: readonly RenderEntity["kind"][];
  definitionIds?: readonly string[];
  minSpeed: number;
  fullSpeed: number;
  /** Particles per second at threshold and full speed. */
  emissionRate?: Readonly<{ min: number; max: number }>;
  colors?: readonly number[];
  sizePx?: Readonly<{ min: number; max: number }>;
  lifeMs?: Readonly<{ min: number; max: number }>;
}

interface MotionTrail {
  entityId: string;
  effect: string;
  vx: number;
  vy: number;
  intensity: number;
  options: MotionTrailOptions;
  spawnAccumulator: number;
}

export const motionTrailIntensity = (
  vx: number,
  vy: number,
  minSpeed: number,
  fullSpeed: number,
): number => {
  const speed = Math.hypot(vx, vy);
  if (speed <= minSpeed) return 0;
  return Math.min(1, (speed - minSpeed) / Math.max(0.001, fullSpeed - minSpeed));
};

interface Overlay {
  entityId: string;
  text: Text;
  remainingMs: number;
  totalMs: number;
}

/**
 * Spec 9.1. Effects are recreated locally from effect events. They are never
 * network entities and never persisted.
 */
export class EffectSystem {
  readonly layer = new Container();
  private readonly particles: Particle[] = [];
  private readonly pool: Graphics[] = [];
  private readonly continuous = new Map<string, Continuous>();
  private motionTrails = new Map<string, MotionTrail>();
  private readonly overlays = new Map<string, Overlay>();
  private positions = new Map<string, { x: number; y: number }>();

  constructor(
    private readonly camera: Camera,
    private readonly maxParticles = 400,
  ) {
    this.layer.label = "effects";
  }

  /** Called each frame with the current screen positions of the entities. */
  setPositions(positions: Map<string, { x: number; y: number }>): void {
    this.positions = positions;
  }

  /** Reconciles renderer-derived trails from the same interpolated entities being drawn. */
  setMotionTrails(
    entities: readonly Readonly<RenderEntity>[],
    options: readonly MotionTrailOptions[],
  ): void {
    const next = new Map<string, MotionTrail>();
    for (const entity of entities) {
      for (const configured of options) {
        if (configured.kinds?.length && !configured.kinds.includes(entity.kind)) continue;
        if (configured.definitionIds?.length &&
            !configured.definitionIds.includes(entity.definitionId)) continue;
        const intensity = motionTrailIntensity(
          entity.vx,
          entity.vy,
          configured.minSpeed,
          configured.fullSpeed,
        );
        if (intensity <= 0 || entity.disabled || entity.respawning) continue;
        const key = `${entity.id}/${configured.effect}`;
        next.set(key, {
          entityId: entity.id,
          effect: configured.effect,
          vx: entity.vx,
          vy: entity.vy,
          intensity,
          options: configured,
          spawnAccumulator: this.motionTrails.get(key)?.spawnAccumulator ?? 0,
        });
      }
    }
    this.motionTrails = next;
  }

  apply(emission: EffectEmission): void {
    const key = `${emission.entityId}/${emission.effect}`;
    if (emission.mode === "start") {
      this.continuous.set(key, {
        entityId: emission.entityId,
        effect: emission.effect,
        spawnAccumulatorMs: 0,
      });
      if (emission.effect === "countdown") {
        this.startCountdown(emission);
      }
      return;
    }
    if (emission.mode === "stop") {
      this.continuous.delete(key);
      const overlay = this.overlays.get(emission.entityId);
      if (overlay && emission.effect === "countdown") {
        this.layer.removeChild(overlay.text);
        overlay.text.destroy();
        this.overlays.delete(emission.entityId);
      }
      return;
    }
    this.burst(emission.entityId, emission.effect);
  }

  private startCountdown(emission: EffectEmission): void {
    const seconds = Number(emission.params?.seconds ?? 3);
    const text = new Text({
      text: String(Math.ceil(seconds)),
      style: { fill: 0xffd166, fontSize: 28, fontWeight: "bold" },
    });
    text.anchor.set(0.5);
    this.layer.addChild(text);
    this.overlays.set(emission.entityId, {
      entityId: emission.entityId,
      text,
      remainingMs: seconds * 1000,
      totalMs: seconds * 1000,
    });
  }

  private colorFor(effect: string): number {
    switch (effect) {
      case "thrustTrail":
        return 0xff8c42;
      case "landingDust":
        return 0xb0a999;
      case "impactBurst":
        return 0xff5d5d;
      case "kickPuff":
        return 0x8ecae6;
      case "portalFlash":
        return 0xc77dff;
      case "spaceSparkle":
        return 0xa7e8ff;
      default:
        return 0xffffff;
    }
  }

  private burst(entityId: string, effect: string, count = 10): void {
    const at = this.positions.get(entityId);
    if (!at) return;
    const color = this.colorFor(effect);
    for (let i = 0; i < count; i++) {
      if (this.particles.length >= this.maxParticles) break;
      const display = this.pool.pop() ?? new Graphics();
      display.clear();
      display.circle(0, 0, 2 + Math.random() * 2).fill({ color });
      this.layer.addChild(display);
      const angle = Math.random() * Math.PI * 2;
      const speed = 20 + Math.random() * 60;
      this.particles.push({
        display,
        x: at.x,
        y: at.y,
        vx: Math.cos(angle) * speed,
        vy: Math.sin(angle) * speed,
        lifeMs: 400 + Math.random() * 300,
        totalMs: 700,
      });
    }
  }

  private spawnMotionParticle(trail: MotionTrail): void {
    const at = this.positions.get(trail.entityId);
    if (!at || this.particles.length >= this.maxParticles) return;
    const speed = Math.max(0.001, Math.hypot(trail.vx, trail.vy));
    const backward = { x: -trail.vx / speed, y: -trail.vy / speed };
    const sideways = { x: -backward.y, y: backward.x };
    const size = trail.options.sizePx ?? { min: 2, max: 6 };
    const lifeRange = trail.options.lifeMs ?? { min: 180, max: 520 };
    const colors = trail.options.colors?.length
      ? trail.options.colors
      : [0xfff3a1, 0xffa62b, 0xff4d1a];
    const display = this.pool.pop() ?? new Graphics();
    display.clear();
    display.circle(
      0,
      0,
      size.min + (size.max - size.min) * trail.intensity * (0.55 + Math.random() * 0.45),
    ).fill({ color: colors[Math.floor(Math.random() * colors.length)]! });
    this.layer.addChild(display);
    const spread = (Math.random() - 0.5) * 34;
    const push = 20 + 52 * trail.intensity * (0.65 + Math.random() * 0.35);
    const lifeMs = lifeRange.min + (lifeRange.max - lifeRange.min) * Math.random();
    this.particles.push({
      display,
      x: at.x + backward.x * (5 + 7 * trail.intensity) + sideways.x * spread * 0.12,
      y: at.y + backward.y * (5 + 7 * trail.intensity) + sideways.y * spread * 0.12,
      vx: backward.x * push + sideways.x * spread,
      vy: backward.y * push + sideways.y * spread,
      lifeMs,
      totalMs: lifeMs,
    });
  }

  update(deltaMs: number): void {
    for (const trail of this.continuous.values()) {
      trail.spawnAccumulatorMs += deltaMs;
      if (trail.spawnAccumulatorMs < 30) continue;
      trail.spawnAccumulatorMs = 0;
      this.burst(trail.entityId, trail.effect, 2);
    }

    for (const trail of this.motionTrails.values()) {
      const rate = trail.options.emissionRate ?? { min: 8, max: 58 };
      const perSecond = rate.min + (rate.max - rate.min) * trail.intensity;
      trail.spawnAccumulator += deltaMs * perSecond / 1_000;
      while (trail.spawnAccumulator >= 1) {
        trail.spawnAccumulator -= 1;
        this.spawnMotionParticle(trail);
      }
    }

    for (let i = this.particles.length - 1; i >= 0; i--) {
      const particle = this.particles[i]!;
      const seconds = deltaMs / 1000;
      particle.x += particle.vx * seconds;
      particle.y += particle.vy * seconds;
      particle.lifeMs -= deltaMs;
      particle.display.position.set(particle.x, particle.y);
      particle.display.alpha = Math.max(0, particle.lifeMs / particle.totalMs);
      if (particle.lifeMs > 0) continue;
      this.layer.removeChild(particle.display);
      this.pool.push(particle.display);
      this.particles.splice(i, 1);
    }

    for (const [entityId, overlay] of this.overlays) {
      overlay.remainingMs -= deltaMs;
      const at = this.positions.get(entityId);
      if (at) overlay.text.position.set(at.x, at.y - 40);
      const seconds = Math.max(0, Math.ceil(overlay.remainingMs / 1000));
      overlay.text.text = String(seconds);
      overlay.text.scale.set(1 + 0.2 * Math.sin(overlay.remainingMs / 80));
    }
    void this.camera;
  }

  destroy(): void {
    this.layer.destroy({ children: true });
  }
}
