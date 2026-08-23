import { afterEach, describe, expect, it, vi } from "vitest";
import { WebSocketRoomTransport } from "../src/net/websocket-transport.js";

class FakeWebSocket {
  static readonly OPEN = 1;
  static readonly sockets: FakeWebSocket[] = [];

  readonly url: string;
  readonly protocols: string[];
  binaryType = "";
  bufferedAmount = 0;
  readyState = 0;
  onopen: (() => void) | null = null;
  onmessage: ((event: MessageEvent) => void) | null = null;
  onerror: (() => void) | null = null;
  onclose: ((event: Pick<CloseEvent, "code" | "reason">) => void) | null = null;

  constructor(url: string | URL, protocols: string | string[] = []) {
    this.url = String(url);
    this.protocols = typeof protocols === "string" ? [protocols] : protocols;
    FakeWebSocket.sockets.push(this);
  }

  open(): void {
    this.readyState = FakeWebSocket.OPEN;
    this.onopen?.();
  }

  disconnect(): void {
    this.readyState = 3;
    this.onclose?.({ code: 1006, reason: "test disconnect" });
  }

  send(): void {}

  close(): void {
    this.readyState = 3;
  }
}

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  FakeWebSocket.sockets.length = 0;
});

describe("WebSocketRoomTransport credentials", () => {
  it("requests a fresh credential for the initial socket and every reconnect", async () => {
    vi.useFakeTimers();
    vi.stubGlobal("WebSocket", FakeWebSocket);
    const credentials = vi
      .fn<() => Promise<string>>()
      .mockResolvedValueOnce("ticket.initial")
      .mockResolvedValueOnce("ticket.reconnect");
    const transport = new WebSocketRoomTransport({
      credentialProvider: credentials,
      backoffMs: [10],
      maxReconnects: 1,
    });

    const opening = transport.connect({
      canvasId: "room one",
      serverUrl: "https://rooms.example.test/base?old=value",
    });
    await vi.waitFor(() => expect(FakeWebSocket.sockets).toHaveLength(1));
    expect(FakeWebSocket.sockets[0]).toMatchObject({
      url: "wss://rooms.example.test/v1/realtime/canvases/room%20one",
      protocols: ["canvas-realtime", "ticket.initial"],
    });
    FakeWebSocket.sockets[0]!.open();
    await opening;

    FakeWebSocket.sockets[0]!.disconnect();
    await vi.advanceTimersByTimeAsync(10);
    await vi.waitFor(() => expect(FakeWebSocket.sockets).toHaveLength(2));

    expect(credentials).toHaveBeenCalledTimes(2);
    expect(FakeWebSocket.sockets[1]!.protocols).toEqual([
      "canvas-realtime",
      "ticket.reconnect",
    ]);
    transport.close();
  });
});
