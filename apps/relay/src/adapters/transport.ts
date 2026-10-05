import { randomBytes, toBase64Url } from "@shellbell/protocol";
import {
  decodeSession,
  QueueBudget,
  type RelayTransport,
  type SessionRecord,
} from "@shellbell/relay-core";

/** Owns runtime sockets; the core receives validated, detached session records. */
export function createCloudflareTransport(
  ctx: DurableObjectState,
  budget = new QueueBudget(),
  onWriteError?: (id: string) => void,
) {
  const sockets = new Map<string, WebSocket>();
  const records = new Map<string, SessionRecord>();
  const ids = new WeakMap<WebSocket, string>();
  // A fresh secure generation fences old callbacks across object lifetimes;
  // the counter guarantees non-reuse within this lifetime without ID history.
  const generation = toBase64Url(randomBytes(16));
  let serial = 0;
  const pending = new Map<string, Uint8Array[]>();
  function flush(id: string) {
    const queue = pending.get(id);
    pending.delete(id);
    const socket = sockets.get(id);
    if (!queue) return;
    for (const bytes of queue) {
      try {
        if (!socket || socket.readyState !== WebSocket.OPEN) throw new Error("socket closed");
        socket.send(bytes);
      } catch {
        if (socket) closeSocket(socket, 1011, "write failed");
        // Capture core ownership before removing the record. The platform's
        // close callback may arrive later than the next routing decision.
        try {
          onWriteError?.(id);
        } finally {
          transport.close(id, 1011, "write failed");
        }
        break;
      } finally {
        budget.release(id, bytes.byteLength);
      }
    }
  }
  function closeSocket(socket: WebSocket, code: number, reason: string) {
    try {
      socket.close(code, reason);
    } catch {
      /* Already closed by the platform. */
    }
  }
  const transport: RelayTransport = {
    session: (id) => {
      const record = records.get(id);
      return record && { ...record };
    },
    sessions: () => [...records.values()].map((session) => ({ ...session })),
    save(session) {
      const socket = sockets.get(session.connId);
      if (!socket) return;
      const record = decodeSession(session);
      socket.serializeAttachment(record);
      records.set(record.connId, record);
    },
    send(id, bytes) {
      const socket = sockets.get(id);
      if (!socket || socket.readyState !== WebSocket.OPEN) return "closed";
      if (!budget.reserve(id, bytes.byteLength)) return "overloaded";
      const queue = pending.get(id);
      if (queue) queue.push(bytes);
      else {
        pending.set(id, [bytes]);
        queueMicrotask(() => flush(id));
      }
      return "sent";
    },
    close(id, code, reason) {
      const socket = sockets.get(id);
      // The caller already captured disconnect ownership. Retire it before a
      // failing accepted write can reenter core.close through onWriteError.
      records.delete(id);
      // Preserve accepted control messages (including auth-fail) before normal
      // closure. Overload drops application-queued frames without replay.
      if (code !== 1013) flush(id);
      pending.delete(id);
      budget.drop(id);
      sockets.delete(id);
      if (socket) {
        ids.delete(socket);
        closeSocket(socket, code, reason);
      }
    },
  };
  {
    // Temporary only: remember all duplicates, including a third occurrence
    // after the first socket has already been rejected and removed.
    const restored = new Set<string>();
    for (const socket of ctx.getWebSockets()) {
      // getWebSockets includes sockets whose close handshake is still pending.
      // Their persisted attachments must not revive routing or attention leases.
      if (socket.readyState !== WebSocket.OPEN) continue;
      try {
        const record = decodeSession(socket.deserializeAttachment());
        if (restored.has(record.connId)) {
          transport.close(record.connId, 4400, "invalid session");
          throw new Error("duplicate connection ID");
        }
        restored.add(record.connId);
        sockets.set(record.connId, socket);
        ids.set(socket, record.connId);
        records.set(record.connId, record);
      } catch {
        closeSocket(socket, 4400, "invalid session");
      }
    }
  }
  return {
    ...transport,
    accept(socket: WebSocket): string {
      let id: string;
      do {
        if (serial === Number.MAX_SAFE_INTEGER) throw new Error("Connection generation exhausted");
        id = `${generation}.${++serial}`;
      } while (sockets.has(id));
      ctx.acceptWebSocket(socket);
      sockets.set(id, socket);
      ids.set(socket, id);
      return id;
    },
    connectionId: (socket: WebSocket) => ids.get(socket),
  };
}
