import type { InnerMessage, InnerMessageOf } from "@shellbell/protocol";

type Ack = InnerMessageOf<"ack">;
export type PairedRequest = InnerMessageOf<
  "input.line" | "input.text" | "input.key" | "input.mouse" | "session.create" | "session.focus"
>;

export function isPairedRequest(message: InnerMessage): message is PairedRequest {
  return (
    message.type === "input.line" ||
    message.type === "input.text" ||
    message.type === "input.key" ||
    message.type === "input.mouse" ||
    message.type === "session.create" ||
    message.type === "session.focus"
  );
}

const COMPLETED_LIMIT = 256;
const PENDING_LIMIT = 256;

/**
 * One ledger per pairing, independent of sockets, handshake keys and future routes.
 * Retains outcomes only in this service process; it cannot resolve a process crash.
 * No terminal content is retained. Read requests belong to their view instead.
 */
export class PairedRequestLedger {
  private readonly completed = new Map<string, Ack>();
  private readonly pending = new Map<string, Promise<Ack>>();

  get idle(): boolean {
    return this.pending.size === 0;
  }

  run(reqId: string, execute: () => Promise<Ack>): Promise<Ack> {
    const completed = this.completed.get(reqId);
    if (completed) return Promise.resolve({ ...completed });
    const pending = this.pending.get(reqId);
    if (pending) return pending;
    // Never evict an unfinished operation: that would permit duplicate execution.
    if (this.pending.size >= PENDING_LIMIT) {
      return Promise.resolve({ type: "ack", reqId, ok: false, error: "busy" });
    }

    let resolve!: (ack: Ack) => void;
    const result = new Promise<Ack>((done) => {
      resolve = done;
    });
    // Reserve before invoking the backend, including synchronously reentrant calls.
    this.pending.set(reqId, result);
    const finish = (ack: Ack) => {
      const saved = { ...ack };
      this.completed.set(reqId, saved);
      if (this.completed.size > COMPLETED_LIMIT) {
        const oldest = this.completed.keys().next().value;
        if (oldest !== undefined) this.completed.delete(oldest);
      }
      this.pending.delete(reqId);
      resolve({ ...saved });
    };
    const unknown = () => finish({ type: "ack", reqId, ok: false, error: "delivery-unknown" });
    try {
      void execute().then((ack) => {
        if (ack.type !== "ack" || ack.reqId !== reqId) unknown();
        else finish(ack);
      }, unknown);
    } catch {
      unknown();
    }
    return result;
  }
}
