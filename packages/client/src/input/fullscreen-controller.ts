import {
  ObserverSet,
  type ObserverErrorHandler,
  type SubscriptionOptions,
} from "../runtime/observers.js";

export type FullscreenObserver = (active: boolean) => void;

type FullscreenElement = HTMLElement & {
  webkitRequestFullscreen?: () => void | Promise<void>;
};

type FullscreenDocument = Document & {
  webkitExitFullscreen?: () => void | Promise<void>;
  webkitFullscreenElement?: Element | null;
};

/** Product-UI-agnostic wrapper around the browser fullscreen contract. */
export class FullscreenController {
  private readonly observers: ObserverSet<boolean>;
  private readonly onChange = (): void => {
    this.observers.publish(this.active);
  };

  constructor(
    private readonly element: HTMLElement,
    private readonly ownerDocument: Document = document,
    onObserverError?: ObserverErrorHandler,
  ) {
    this.observers = new ObserverSet(onObserverError);
    this.ownerDocument.addEventListener("fullscreenchange", this.onChange);
    this.ownerDocument.addEventListener("webkitfullscreenchange", this.onChange);
  }

  get active(): boolean {
    const candidate = this.ownerDocument as FullscreenDocument;
    return (this.ownerDocument.fullscreenElement ?? candidate.webkitFullscreenElement) ===
      this.element;
  }

  subscribe(observer: FullscreenObserver, options?: SubscriptionOptions): () => void {
    return this.observers.subscribe(observer, options, () => this.active);
  }

  async enter(): Promise<boolean> {
    if (this.active) return true;
    const candidate = this.element as FullscreenElement;
    const request = this.element.requestFullscreen?.bind(this.element) ??
      candidate.webkitRequestFullscreen?.bind(candidate);
    if (!request) return false;
    await request();
    return this.active;
  }

  async exit(): Promise<boolean> {
    if (!this.active) return false;
    const candidate = this.ownerDocument as FullscreenDocument;
    const exit = this.ownerDocument.exitFullscreen?.bind(this.ownerDocument) ??
      candidate.webkitExitFullscreen?.bind(candidate);
    if (!exit) return false;
    await exit();
    return this.active;
  }

  async toggle(): Promise<boolean> {
    if (this.active) {
      await this.exit();
      return false;
    }
    return this.enter();
  }

  destroy(): void {
    this.ownerDocument.removeEventListener("fullscreenchange", this.onChange);
    this.ownerDocument.removeEventListener("webkitfullscreenchange", this.onChange);
    this.observers.clear();
  }
}
