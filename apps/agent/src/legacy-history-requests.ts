import {
  encodeCbor,
  FRAME_LIMITS,
  type InnerMessageOf,
  InnerMessageSchema,
  MAX_PAIRINGS,
  STREAM_LIMITS,
} from "@shellbell/protocol";
import { SessionGone, type TerminalBackend } from "./backends/types.js";

export interface LegacyHistoryRequestsOptions {
  read: TerminalBackend["getHistory"];
  now: () => number;
  onReady: (owner: object) => void;
}

type Request = InnerMessageOf<"history.get">;
type Reply = InnerMessageOf<"history">;
type Ack = InnerMessageOf<"ack">;

interface Slot {
  readonly owner: object;
  readonly request: Request;
  readonly promise: Promise<Ack>;
  readonly resolve: (ack: Ack) => void;
  phase: "reading" | "ready";
  deadline: number;
  page?: Reply;
  sending: boolean;
}

/** Bounded local ownership for legacy history; the caller supplies scheduling and transport. */
export class LegacyHistoryRequests {
  private readonly options: LegacyHistoryRequestsOptions;
  private readonly slots = new Map<object, Slot>();
  private readonly permits = new Map<string, symbol>();
  private lastNow: number;

  constructor(options: LegacyHistoryRequestsOptions) {
    this.options = { ...options };
    const now = this.options.now();
    if (!Number.isFinite(now)) throw new RangeError("Invalid legacy history clock");
    this.lastNow = now;
  }

  request(owner: object, message: Request): Promise<Ack> {
    let request: Request;
    try {
      const parsed = InnerMessageSchema.safeParse(message);
      if (!parsed.success || parsed.data.type !== "history.get") {
        throw new TypeError();
      }
      request = parsed.data;
    } catch {
      throw new TypeError("Invalid legacy history request");
    }
    const now = this.clock();
    this.expire(now);
    const active = this.slots.get(owner);
    if (active) {
      if (active.request.reqId === request.reqId) return active.promise;
      return Promise.resolve(this.failure(request.reqId, "busy"));
    }
    if (
      this.slots.size >= MAX_PAIRINGS ||
      this.permits.size >= MAX_PAIRINGS ||
      this.permits.has(request.sessionId)
    ) {
      return Promise.resolve(this.failure(request.reqId, "busy"));
    }

    let resolve!: (ack: Ack) => void;
    const promise = new Promise<Ack>((settle) => {
      resolve = settle;
    });
    const slot: Slot = {
      owner,
      request,
      promise,
      resolve,
      phase: "reading",
      deadline: now + STREAM_LIMITS.totalMs,
      sending: false,
    };
    const permit = Symbol();
    this.slots.set(owner, slot);
    this.permits.set(request.sessionId, permit);
    try {
      const result = this.options.read(request.sessionId, request.before, request.count);
      void Promise.resolve(result).then(
        (value) => this.completeRead(slot, permit, value),
        (error: unknown) => this.failRead(slot, permit, error),
      );
    } catch (error) {
      this.failRead(slot, permit, error);
    }
    return promise;
  }

  sendOne(owner: object, send: (message: Reply) => boolean): boolean {
    const now = this.clock();
    this.expire(now);
    const slot = this.slots.get(owner);
    if (slot?.phase !== "ready" || !slot.page || slot.sending) return false;
    slot.sending = true;
    let result: unknown;
    try {
      result = send(slot.page);
    } catch {
      this.retire(slot, this.failure(slot.request.reqId, "history-unavailable"));
      throw new Error("Legacy history send failed");
    } finally {
      slot.sending = false;
    }
    if (result === true) {
      this.retire(slot, { type: "ack", reqId: slot.request.reqId, ok: true });
      return true;
    }
    if (result === false) return false;
    observeRejection(result);
    this.retire(slot, this.failure(slot.request.reqId, "history-unavailable"));
    throw new Error("Legacy history send failed");
  }

  hasReady(owner: object): boolean {
    const now = this.clock();
    this.expire(now);
    const slot = this.slots.get(owner);
    return slot?.phase === "ready" && !slot.sending;
  }

  cancel(owner: object): void {
    const slot = this.slots.get(owner);
    if (slot) this.retire(slot, this.failure(slot.request.reqId, "cancelled"));
  }

  clear(): void {
    const slots = [...this.slots.values()];
    this.slots.clear();
    for (const slot of slots) {
      slot.page = undefined;
      slot.resolve(this.failure(slot.request.reqId, "cancelled"));
    }
  }

  tick(): void {
    this.expire(this.clock());
  }

  nextDeadline(): number | null {
    let next = Number.POSITIVE_INFINITY;
    for (const slot of this.slots.values()) next = Math.min(next, slot.deadline);
    return Number.isFinite(next) ? next : null;
  }

  private clock(): number {
    const now = this.options.now();
    if (!Number.isFinite(now)) throw new RangeError("Invalid legacy history clock");
    this.lastNow = Math.max(this.lastNow, now);
    return this.lastNow;
  }

  private expire(now: number): void {
    for (const slot of this.slots.values()) {
      if (now >= slot.deadline) {
        this.retire(slot, this.failure(slot.request.reqId, "history-unavailable"));
      }
    }
  }

  private releasePermit(slot: Slot, permit: symbol): void {
    if (this.permits.get(slot.request.sessionId) === permit) {
      this.permits.delete(slot.request.sessionId);
    }
  }

  private completeRead(slot: Slot, permit: symbol, value: unknown): void {
    this.releasePermit(slot, permit);
    if (this.slots.get(slot.owner) !== slot) return;
    let now: number;
    try {
      now = this.clock();
    } catch {
      this.retire(slot, this.failure(slot.request.reqId, "history-unavailable"));
      return;
    }
    if (this.slots.get(slot.owner) !== slot) return;
    if (now >= slot.deadline) {
      this.retire(slot, this.failure(slot.request.reqId, "history-unavailable"));
      return;
    }
    try {
      const result = value as Awaited<ReturnType<TerminalBackend["getHistory"]>>;
      const candidate = {
        type: "history" as const,
        sessionId: slot.request.sessionId,
        before: slot.request.before,
        lines: result.lines.slice(-200),
        oldestAvailable: result.oldestAvailable,
      };
      const parsed = InnerMessageSchema.safeParse(candidate);
      if (!parsed.success || parsed.data.type !== "history") {
        this.retire(slot, this.failure(slot.request.reqId, "history-unavailable"));
        return;
      }
      const page = parsed.data;
      if (encodeCbor(page).byteLength > FRAME_LIMITS.e2eFromAgent) {
        this.retire(slot, this.failure(slot.request.reqId, "history-too-large"));
        return;
      }
      const handoffNow = this.clock();
      if (this.slots.get(slot.owner) !== slot) return;
      if (handoffNow >= slot.deadline) {
        this.retire(slot, this.failure(slot.request.reqId, "history-unavailable"));
        return;
      }
      slot.page = page;
      slot.phase = "ready";
      slot.deadline = handoffNow + STREAM_LIMITS.progressMs;
      let notification: unknown;
      try {
        notification = this.options.onReady(slot.owner);
      } catch {
        this.retire(slot, this.failure(slot.request.reqId, "history-unavailable"));
        return;
      }
      observeRejection(notification, () => {
        this.retire(slot, this.failure(slot.request.reqId, "history-unavailable"));
      });
    } catch {
      this.retire(slot, this.failure(slot.request.reqId, "history-unavailable"));
    }
  }

  private failRead(slot: Slot, permit: symbol, error: unknown): void {
    this.releasePermit(slot, permit);
    if (this.slots.get(slot.owner) !== slot) return;
    let now: number;
    try {
      now = this.clock();
    } catch {
      this.retire(slot, this.failure(slot.request.reqId, "history-unavailable"));
      return;
    }
    if (this.slots.get(slot.owner) !== slot) return;
    if (now >= slot.deadline) {
      this.retire(slot, this.failure(slot.request.reqId, "history-unavailable"));
      return;
    }
    let code: "session-gone" | "history-unavailable" = "history-unavailable";
    try {
      if (error instanceof SessionGone) code = "session-gone";
    } catch {
      // A rejected Proxy can throw during prototype inspection.
    }
    if (this.slots.get(slot.owner) !== slot) return;
    try {
      now = this.clock();
    } catch {
      this.retire(slot, this.failure(slot.request.reqId, "history-unavailable"));
      return;
    }
    if (this.slots.get(slot.owner) !== slot) return;
    if (now >= slot.deadline) {
      this.retire(slot, this.failure(slot.request.reqId, "history-unavailable"));
      return;
    }
    this.retire(slot, this.failure(slot.request.reqId, code));
  }

  private retire(slot: Slot, ack: Ack): void {
    if (this.slots.get(slot.owner) !== slot) return;
    this.slots.delete(slot.owner);
    slot.page = undefined;
    slot.resolve(ack);
  }

  private failure(reqId: string, error: string): Ack {
    return { type: "ack", reqId, ok: false, error };
  }
}

function observeRejection(value: unknown, onReject?: () => void): void {
  if (value === null || (typeof value !== "object" && typeof value !== "function")) return;
  void new Promise<unknown>((resolve) => resolve(value)).catch(() => onReject?.());
}
