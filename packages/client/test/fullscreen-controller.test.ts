import { describe, expect, it, vi } from "vitest";
import { FullscreenController } from "../src/input/fullscreen-controller.js";

class FullscreenDocument {
  fullscreenElement: Element | null = null;
  readonly listeners = new Set<() => void>();
  exitFullscreen = vi.fn(async () => {
    this.fullscreenElement = null;
    this.emit();
  });

  addEventListener(_type: string, listener: EventListenerOrEventListenerObject): void {
    this.listeners.add(listener as () => void);
  }

  removeEventListener(_type: string, listener: EventListenerOrEventListenerObject): void {
    this.listeners.delete(listener as () => void);
  }

  emit(): void {
    for (const listener of this.listeners) listener();
  }
}

describe("FullscreenController", () => {
  it("enters, exits, toggles, and publishes fullscreen state", async () => {
    const document = new FullscreenDocument();
    const element = {
      requestFullscreen: vi.fn(async () => {
        document.fullscreenElement = element as unknown as Element;
        document.emit();
      }),
    } as unknown as HTMLElement;
    const controller = new FullscreenController(
      element,
      document as unknown as Document,
    );
    const states: boolean[] = [];
    const unsubscribe = controller.subscribe((active) => states.push(active));

    expect(await controller.enter()).toBe(true);
    expect(controller.active).toBe(true);
    expect(await controller.toggle()).toBe(false);
    expect(controller.active).toBe(false);
    expect(states).toEqual([false, true, false]);

    unsubscribe();
    controller.destroy();
    expect(document.listeners.size).toBe(0);
  });

  it("reports unsupported fullscreen without throwing", async () => {
    const controller = new FullscreenController(
      {} as HTMLElement,
      new FullscreenDocument() as unknown as Document,
    );

    expect(await controller.enter()).toBe(false);
    expect(await controller.exit()).toBe(false);
  });
});
