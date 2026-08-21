import type { DragIntent } from "./pointer-drag-controller.js";

/** Keyboard intent for desktop testing. It produces the same intent shape. */
export class KeyboardController {
  private readonly pressed = new Set<string>();
  private readonly detach: () => void;

  constructor(target: Window = window) {
    const onDown = (event: KeyboardEvent) => {
      this.pressed.add(event.key.toLowerCase());
    };
    const onUp = (event: KeyboardEvent) => {
      this.pressed.delete(event.key.toLowerCase());
    };
    target.addEventListener("keydown", onDown);
    target.addEventListener("keyup", onUp);
    this.detach = () => {
      target.removeEventListener("keydown", onDown);
      target.removeEventListener("keyup", onUp);
    };
  }

  get intent(): DragIntent {
    let x = 0;
    let y = 0;
    if (this.pressed.has("arrowleft") || this.pressed.has("a")) x -= 1;
    if (this.pressed.has("arrowright") || this.pressed.has("d")) x += 1;
    if (this.pressed.has("arrowup") || this.pressed.has("w")) y -= 1;
    if (this.pressed.has("arrowdown") || this.pressed.has("s")) y += 1;
    const distance = Math.hypot(x, y);
    if (distance === 0) {
      return { direction: { x: 0, y: 0 }, intensity: 0, held: false };
    }
    return {
      direction: { x: x / distance, y: y / distance },
      intensity: 1,
      held: true,
    };
  }

  destroy(): void {
    this.detach();
  }
}
