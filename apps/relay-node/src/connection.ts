import { frameLimitFor, type InboundQueue, type RelayCore } from "@shellbell/relay-core";
import type { RawData } from "ws";
import type { createNodeTransport, NodeSocket } from "./transport.js";

interface ConnectionSocket extends NodeSocket {
  on(event: "message", listener: (data: RawData, isBinary: boolean) => void): unknown;
  on(event: "close" | "error", listener: () => void): unknown;
}
interface ConnectionOptions {
  core: Pick<RelayCore, "open" | "message" | "close">;
  transport: ReturnType<typeof createNodeTransport>;
  inbound: InboundQueue;
  track(action: () => Promise<void>): Promise<void>;
  isStopping(): boolean;
  isClosed(): boolean;
}

/** Owns one accepted connection's handlers; the server owns socket shutdown. */
export function bindNodeConnection(socket: ConnectionSocket, options: ConnectionOptions): void {
  const { core, transport, inbound, track } = options;
  const id = transport.accept(socket);
  const finish = () => {
    if (options.isClosed() || !transport.session(id)) return;
    // Capture/remove this generation synchronously, before queuing tracked work.
    const task = core.close(id);
    void track(() => task);
  };
  socket.on("close", finish);
  socket.on("error", finish);
  socket.on("message", (data, isBinary) => {
    if (options.isStopping()) return;
    const session = transport.session(id);
    if (!session) return;
    const length = Array.isArray(data)
      ? data.reduce((total, part) => total + part.byteLength, 0)
      : data.byteLength;
    if (length > frameLimitFor(session.state, false)) {
      socket.close(4413, "too large");
      const task = core.close(id);
      void track(() => task);
      return;
    }
    const release = inbound.admit(id, length);
    if (!release) {
      socket.close(1013, "overloaded");
      const task = core.close(id);
      void track(() => task);
      return;
    }
    let bytes: Buffer;
    try {
      bytes = Array.isArray(data)
        ? Buffer.concat(data, length)
        : data instanceof ArrayBuffer
          ? Buffer.from(data)
          : data;
    } catch {
      release();
      socket.close(1011, "read failed");
      finish();
      return;
    }
    if (!isBinary && bytes.toString("utf8") === "ping") {
      const result = transport.sendText(id, "pong");
      release();
      if (result !== "sent") {
        socket.close(result === "overloaded" ? 1013 : 1000, "closed");
        finish();
      }
      return;
    }
    void track(() =>
      core.message(id, isBinary ? new Uint8Array(bytes) : bytes.toString("utf8")),
    ).finally(() => {
      release();
    });
  });
  void track(() => core.open(id));
}
