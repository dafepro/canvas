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
  closeCalls = 0;
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
    this.closeCalls++;
    this.readyState = 3;
  }
}

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  FakeWebSocket.sockets.length = 0;
});

describe("WebSocketRoomTransport credentials", () => {
  it("separates credential acquisition from the socket handshake", async () => {
    vi.stubGlobal("WebSocket", FakeWebSocket);
    let releaseCredential!: (value: string) => void;
    const credential = new Promise<string>((resolve) => { releaseCredential = resolve; });
    const transport = new WebSocketRoomTransport({
      credentialProvider: () => credential,
    });
    const statuses: string[] = [];
    transport.onStatus((status) => statuses.push(status));

    const opening = transport.connect({
      roomId: "phased-room",
      serverUrl: "http://rooms.example.test",
    });
    expect(statuses).toEqual(["credentials"]);
    expect(FakeWebSocket.sockets).toHaveLength(0);

    releaseCredential("ticket.phased");
    await vi.waitFor(() => expect(FakeWebSocket.sockets).toHaveLength(1));
    expect(statuses).toEqual(["credentials", "connecting"]);
    FakeWebSocket.sockets[0]!.open();
    await opening;
    expect(statuses).toEqual(["credentials", "connecting", "open"]);
    transport.close();
  });

  it("rejects when a socket closes before its opening handshake completes", async () => {
    vi.useFakeTimers();
    vi.stubGlobal("WebSocket", FakeWebSocket);
    const transport = new WebSocketRoomTransport({
      credentialProvider: async () => "ticket.closed",
      backoffMs: [100],
      maxReconnects: 1,
    });

    const opening = transport.connect({
      roomId: "closed-room",
      serverUrl: "http://rooms.example.test",
    });
    await vi.waitFor(() => expect(FakeWebSocket.sockets).toHaveLength(1));
    const rejection = expect(opening).rejects.toThrow(
      "websocket closed before opening: test disconnect",
    );
    FakeWebSocket.sockets[0]!.disconnect();

    await rejection;
    transport.close();
  });

  it("rejects and closes a socket that never finishes connecting", async () => {
    vi.useFakeTimers();
    vi.stubGlobal("WebSocket", FakeWebSocket);
    const transport = new WebSocketRoomTransport({
      credentialProvider: async () => "ticket.timeout",
      connectTimeoutMs: 50,
    });

    const opening = transport.connect({
      roomId: "slow-room",
      serverUrl: "http://rooms.example.test",
    });
    await vi.waitFor(() => expect(FakeWebSocket.sockets).toHaveLength(1));
    const rejection = expect(opening).rejects.toThrow(
      "websocket connection timed out after 50ms",
    );
    await vi.advanceTimersByTimeAsync(50);

    await rejection;
    expect(FakeWebSocket.sockets[0]!.closeCalls).toBe(1);
    expect(transport.status).toBe("failed");
  });

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
      roomId: "room one",
      serverUrl: "https://rooms.example.test/base?old=value",
    });
    await vi.waitFor(() => expect(FakeWebSocket.sockets).toHaveLength(1));
    expect(FakeWebSocket.sockets[0]).toMatchObject({
      url: "wss://rooms.example.test/v1/realtime/rooms/room%20one",
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
