/** The WebSocket surface adapters use, satisfied by Workers, browser and `ws` sockets alike. */
export interface SocketLike {
  send(data: string | ArrayBuffer): void;
  close(code?: number, reason?: string): void;
  // Event shapes differ across Workers, browsers and the ws package; adapters read `data`, `code`, `message`.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  addEventListener(type: "message" | "close" | "error", fn: (e: any) => void): void;
}

/** Opens a WebSocket with request headers (e.g. Authorization); injected so adapters run in Workers and Node. */
export type Connect = (url: string, headers: Record<string, string>) => Promise<SocketLike>;
