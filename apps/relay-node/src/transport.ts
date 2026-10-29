import { randomUUID } from "node:crypto";
import {
  decodeSession,
  type QueueBudget,
  type RelayTransport,
  type SessionRecord,
} from "@shellbell/relay-core";

/** ws exposes a write callback; production sockets and embedded transports share this seam. */
export interface NodeSocket {
  readonly readyState: number;
  readonly bufferedAmount: number;
  send(bytes: Uint8Array | string, done: (error?: Error) => void): void;
  close(code: number, reason: string): void;
}
export function createNodeTransport(
  budget: QueueBudget,
  connectionBytes: number,
  onWriteError?: (id: string) => void,
) {
  const sockets = new Map<string, NodeSocket>();
  const records = new Map<string, SessionRecord>();
  const pending = new Map<string, Set<() => void>>();
  const transport: RelayTransport = {
    session: (id) => {
      const record = records.get(id);
      return record && { ...record };
    },
    sessions: () => [...records.values()].map((record) => ({ ...record })),
    save(session) {
      if (sockets.has(session.connId)) records.set(session.connId, decodeSession(session));
    },
    send: (id, bytes) => send(id, bytes),
    close(id, code, reason) {
      const socket = sockets.get(id);
      sockets.delete(id);
      records.delete(id);
      // Bytes already handed to the socket stay counted: ws keeps them for up to its close
      // timeout. Each write callback releases its own, and socketGone releases the rest.
      if (!pending.get(id)?.size) socketGone(id);
      if (socket)
        try {
          socket.close(code, reason);
        } catch {
          /* The socket may already be closed. */
        }
    },
  };
  function send(id: string, bytes: Uint8Array | string): ReturnType<RelayTransport["send"]> {
    const socket = sockets.get(id);
    if (socket?.readyState !== 1) return "closed";
    const length = typeof bytes === "string" ? Buffer.byteLength(bytes) : bytes.byteLength;
    // Application reservations include bytes still awaiting ws write callbacks.
    if (socket.bufferedAmount + length > connectionBytes || !budget.reserve(id, length))
      return "overloaded";
    let released = false;
    const release = () => {
      if (released) return;
      released = true;
      budget.release(id, length);
      const held = pending.get(id);
      held?.delete(release);
      if (held && !held.size && !sockets.has(id)) socketGone(id);
    };
    pending.get(id)!.add(release);
    try {
      socket.send(bytes, (error) => {
        release();
        if (error) {
          socket.close(1011, "write failed");
          onWriteError?.(id);
          transport.close(id, 1011, "write failed");
        }
      });
      return "sent";
    } catch {
      release();
      onWriteError?.(id);
      transport.close(id, 1011, "write failed");
      return "closed";
    }
  }
  /** The socket closed for good: anything it still held can no longer be written. */
  function socketGone(id: string): void {
    if (sockets.has(id)) return;
    const held = pending.get(id);
    pending.delete(id);
    for (const release of held ?? []) release();
    budget.drop(id);
  }
  return {
    ...transport,
    socketGone,
    sendText: (id: string, text: string) => send(id, text),
    accept(socket: NodeSocket) {
      const id = randomUUID();
      sockets.set(id, socket);
      pending.set(id, new Set());
      return id;
    },
  };
}
