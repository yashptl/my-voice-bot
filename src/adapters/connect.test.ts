import { createHash } from "node:crypto";
import { createServer, type AddressInfo, type Server } from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";
import { WebSocketServer } from "ws";
import { connectNode, connectWorker } from "./connect";

const until = async (cond: () => boolean, ms = 2000) => {
  const deadline = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > deadline) throw new Error("timed out waiting");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
};

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  vi.unstubAllGlobals();
  for (const fn of cleanups.splice(0)) await fn();
});

describe("connectWorker", () => {
  function fakeWorkerSocket(log: string[]) {
    return {
      set binaryType(v: string) {
        log.push(`binaryType=${v}`);
      },
      accept: () => log.push("accept"),
      send: () => {},
      close: () => {},
      addEventListener: () => {},
    };
  }

  it("upgrades over fetch with the headers, sets arraybuffer before accept, and returns the socket", async () => {
    const log: string[] = [];
    const ws = fakeWorkerSocket(log);
    const calls: { url: string; init: RequestInit }[] = [];
    vi.stubGlobal("fetch", async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      return { status: 101, webSocket: ws };
    });
    const socket = await connectWorker("wss://api.minimax.io/ws/v1/t2a_v2", { Authorization: "Bearer k" });
    expect(calls).toEqual([
      { url: "https://api.minimax.io/ws/v1/t2a_v2", init: { headers: { Upgrade: "websocket", Authorization: "Bearer k" } } },
    ]);
    expect(log).toEqual(["binaryType=arraybuffer", "accept"]);
    expect(socket).toBe(ws);
  });

  it("maps ws: to http:", async () => {
    const urls: string[] = [];
    vi.stubGlobal("fetch", async (url: string) => {
      urls.push(url);
      return { status: 101, webSocket: fakeWorkerSocket([]) };
    });
    await connectWorker("ws://localhost:8787/x", {});
    expect(urls).toEqual(["http://localhost:8787/x"]);
  });

  it("rejects with the HTTP status and a short body when the upgrade is refused", async () => {
    vi.stubGlobal("fetch", async () => ({ status: 401, webSocket: null, text: async () => "invalid api key" }));
    await expect(connectWorker("wss://api.minimax.io/ws/v1/t2a_v2", {})).rejects.toThrow(
      /api\.minimax\.io.*401.*invalid api key/,
    );
  });
});

describe("connectNode", () => {
  /** A bare TCP server that answers the upgrade and a first text frame in ONE write. */
  async function eagerServer(firstMessage: string) {
    const requests: string[] = [];
    const sockets = new Set<import("node:net").Socket>();
    const server: Server = createServer((sock) => {
      sockets.add(sock);
      let head = "";
      sock.on("data", (d) => {
        head += d.toString("latin1");
        if (!head.includes("\r\n\r\n")) return;
        requests.push(head);
        const key = /sec-websocket-key:\s*(\S+)/i.exec(head)?.[1] ?? "";
        const accept = createHash("sha1").update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`).digest("base64");
        const payload = Buffer.from(firstMessage);
        sock.write(
          Buffer.concat([
            Buffer.from(
              `HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`,
            ),
            Buffer.from([0x81, payload.length]),
            payload,
          ]),
        );
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    cleanups.push(
      () =>
        new Promise<void>((resolve) => {
          for (const s of sockets) s.destroy(); // it never answers the close handshake
          server.close(() => resolve());
        }),
    );
    return { url: `ws://127.0.0.1:${(server.address() as AddressInfo).port}`, requests };
  }

  async function echoServer(o: { reject?: number } = {}) {
    const wss = new WebSocketServer({
      port: 0,
      host: "127.0.0.1",
      verifyClient: o.reject ? (_info, cb) => cb(false, o.reject, "nope") : undefined,
    });
    wss.on("connection", (ws) => ws.on("message", (data, isBinary) => ws.send(data, { binary: isBinary })));
    await new Promise<void>((resolve) => wss.on("listening", () => resolve()));
    cleanups.push(() => new Promise<void>((resolve) => wss.close(() => resolve())));
    return `ws://127.0.0.1:${(wss.address() as AddressInfo).port}`;
  }

  it("sends the request headers on the upgrade", async () => {
    const { url, requests } = await eagerServer("hi");
    const socket = await connectNode(url, { Authorization: "Bearer test-key" });
    cleanups.push(() => socket.close());
    expect(requests[0]).toMatch(/authorization: Bearer test-key/i);
  });

  it("keeps a message that arrives with the upgrade response for listeners attached after connect resolves", async () => {
    const { url } = await eagerServer('{"event":"connected_success"}');
    const socket = await connectNode(url, {});
    cleanups.push(() => socket.close());
    const got: unknown[] = [];
    socket.addEventListener("message", (e: { data: unknown }) => got.push(e.data));
    await until(() => got.length > 0);
    expect(got).toEqual(['{"event":"connected_success"}']);
  });

  it("delivers early messages to every listener attached right after connect", async () => {
    const { url } = await eagerServer("early");
    const socket = await connectNode(url, {});
    cleanups.push(() => socket.close());
    const a: unknown[] = [];
    const b: unknown[] = [];
    socket.addEventListener("message", (e: { data: unknown }) => a.push(e.data));
    await Promise.resolve();
    socket.addEventListener("message", (e: { data: unknown }) => b.push(e.data));
    await until(() => b.length > 0);
    expect([a, b]).toEqual([["early"], ["early"]]);
  });

  it("round-trips text as strings and binary as ArrayBuffers, then reports close codes", async () => {
    const socket = await connectNode(await echoServer(), {});
    const got: unknown[] = [];
    const closes: number[] = [];
    socket.addEventListener("message", (e: { data: unknown }) => got.push(e.data));
    socket.addEventListener("close", (e: { code: number }) => closes.push(e.code));
    socket.send("hello");
    socket.send(new Uint8Array([1, 2, 3]).buffer);
    await until(() => got.length === 2);
    expect(got[0]).toBe("hello");
    expect(got[1]).toBeInstanceOf(ArrayBuffer);
    expect([...new Uint8Array(got[1] as ArrayBuffer)]).toEqual([1, 2, 3]);
    socket.close(1000, "bye");
    await until(() => closes.length === 1);
    expect(closes).toEqual([1000]);
  });

  it("rejects with the HTTP status when the server refuses the upgrade", async () => {
    await expect(connectNode(await echoServer({ reject: 401 }), {})).rejects.toThrow(/401/);
  });
});
