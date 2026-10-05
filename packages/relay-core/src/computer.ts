import {
  type CtrlMessage,
  type CtrlMessageOf,
  decodeRoutableEnvelope,
  encodeEnvelope,
  fromBase64Url,
  ProtocolError,
  parseCtrl,
  toBase64Url,
} from "@shellbell/protocol";
import { verifyAuthMessage } from "./auth.js";
import { authenticate } from "./authentication.js";
import { nextDeadline, PAIRING_TIMEOUT_MS, UNAUTH_TIMEOUT_MS } from "./deadlines.js";
import { drainDisconnections } from "./disconnections.js";
import { frameLimitFor, MAX_COMPUTER_CONNECTIONS, TokenBucket } from "./limits.js";
import { agentControl, pairingControl } from "./pairing.js";
import type { IdentityStore } from "./ports/identity-store.js";
import type { NotificationService } from "./ports/notifications.js";
import type { RuntimeServices } from "./ports/runtime.js";
import type { RelayTransport, WakeupScheduler } from "./ports/transport.js";
import { submitRevocation } from "./revocation.js";
import { phoneControl, routeCiphertext } from "./routing.js";
import type { SessionRecord } from "./session.js";

export interface RelayCore {
  open(connId: string): Promise<void>;
  message(connId: string, frame: Uint8Array | string): Promise<void>;
  close(connId: string): Promise<void>;
  /** Runtime may own delivery lifetime separately from local deadline maintenance. */
  wakeup(options?: { deferDelivery(task: Promise<void>): void }): Promise<void>;
  /** Recompute durable deadlines without starting notification delivery. */
  reschedule(): Promise<void>;
}
export interface RelayCoreOptions {
  computerFp: string;
  identity: IdentityStore;
  transport: RelayTransport;
  scheduler: WakeupScheduler;
  runtime: RuntimeServices;
  notifications: NotificationService;
  minFrameMs?: number;
}

/** Internal transition context shared by the focused protocol handlers. */
export interface TransitionContext extends RelayCoreOptions {
  sessions(): readonly SessionRecord[];
  current(session: SessionRecord): boolean;
  save(session: SessionRecord): void;
  drop(session: SessionRecord, code: number, reason: string): void;
  send(session: SessionRecord, message: CtrlMessage): boolean;
  agent(): SessionRecord | undefined;
}

export function createRelayCore(options: RelayCoreOptions): RelayCore {
  const { identity, transport, scheduler, runtime, notifications } = options;
  let tail: Promise<unknown> = Promise.resolve();
  let delivery: Promise<void> | null = null;
  const buckets = new Map<string, TokenBucket>();
  const claims = new Map<string, string>();
  const disconnected: SessionRecord[] = [];
  const token = (s: SessionRecord) => `${s.connId}:${s.nonce}`;
  const claimKey = (role: string, fp: string) => `${role}:${fp}`;
  const sessions = () => transport.sessions();
  const current = (s: SessionRecord) => transport.session(s.connId)?.nonce === s.nonce;
  function sequence<T>(action: () => Promise<T>): Promise<T> {
    const task = tail.then(action, action);
    tail = task;
    return task;
  }
  const context: TransitionContext = {
    ...options,
    sessions,
    current,
    agent: () => sessions().find((s) => s.state === "agent"),
    save(session) {
      if (current(session)) transport.save(session);
    },
    drop(session, code, reason) {
      // The generation may have authenticated since the caller captured it.
      // Preserve ownership, but clean up its latest role and identity.
      const owned = transport.session(session.connId);
      if (!owned || token(owned) !== token(session)) return;
      buckets.delete(owned.connId);
      transport.close(owned.connId, code, reason);
      disconnected.push(owned);
    },
    send(session, body) {
      if (!current(session)) return false;
      const result = transport.send(
        session.connId,
        encodeEnvelope({ v: 1, t: "ctrl", from: "relay", seq: 0, body }),
      );
      if (result === "overloaded") {
        runtime.report("overload");
        context.drop(session, 1013, "overloaded");
      }
      if (result === "closed") context.drop(session, 1000, "closed");
      return result === "sent";
    },
  };
  async function schedule() {
    const computer = await identity.computer();
    const window = await identity.window();
    const notification = await notifications.nextDeadline();
    await scheduler.replace(
      nextDeadline(runtime.now(), sessions(), computer, window, notification),
    );
  }
  async function settleTransition(): Promise<void> {
    await drainDisconnections(context, disconnected);
    await schedule();
  }
  function pump(): Promise<void> {
    if (delivery) return delivery;
    delivery = (async () => {
      try {
        await notifications.pump();
      } catch (error) {
        runtime.report("provider-failure");
        throw error;
      }
      await sequence(settleTransition);
    })().finally(() => {
      delivery = null;
    });
    return delivery;
  }
  function authClaim(session: SessionRecord, msg: CtrlMessageOf<"auth">) {
    if (msg.role === "pairing" || (msg.role === "agent" && msg.fp !== options.computerFp)) return;
    if (verifyAuthMessage(msg, session.connId, fromBase64Url(session.nonce)) === "ok") {
      claims.set(claimKey(msg.role, msg.fp), token(session));
    }
  }
  function ownsAuth(session: SessionRecord, msg: CtrlMessageOf<"auth">) {
    return (
      current(session) &&
      (msg.role === "pairing" || claims.get(claimKey(msg.role, msg.fp)) === token(session))
    );
  }
  return {
    reschedule: () => sequence(settleTransition),
    open(connId) {
      if (sessions().length >= MAX_COMPUTER_CONNECTIONS && !transport.session(connId)) {
        transport.close(connId, 1013, "connection limit");
        return Promise.resolve();
      }
      // Establish generation immediately: a queued old completion cannot save over a new challenge.
      const session: SessionRecord = {
        version: 1,
        connId,
        nonce: toBase64Url(runtime.randomBytes(32)),
        since: runtime.now(),
        state: "unauth",
        fp: null,
        name: null,
        leaseUntil: 0,
      };
      transport.save(session);
      buckets.delete(connId);
      context.send(session, { type: "challenge", connId, nonce: fromBase64Url(session.nonce) });
      return sequence(settleTransition);
    },
    async message(connId, frame) {
      const session = transport.session(connId);
      if (!session) return;
      const bucket = buckets.get(connId) ?? new TokenBucket();
      buckets.set(connId, bucket);
      if (!bucket.take(runtime.now())) {
        context.drop(session, 4429, "rate limited");
        return sequence(settleTransition);
      }
      const limit = frameLimitFor(session.state, false);
      if (typeof frame === "string") {
        const oversized =
          frame.length > limit || new TextEncoder().encode(frame).byteLength > limit;
        context.drop(session, oversized ? 4413 : 4400, oversized ? "too large" : "malformed");
        return sequence(settleTransition);
      }
      if (frame.byteLength > limit) {
        context.drop(session, 4413, "too large");
        return sequence(settleTransition);
      }
      // Own the bytes even when Node adapters pass Buffer views.
      const raw = new Uint8Array(frame);
      let envelope: ReturnType<typeof decodeRoutableEnvelope>;
      let message: CtrlMessage | undefined;
      try {
        envelope = decodeRoutableEnvelope(raw);
        if (raw.byteLength > frameLimitFor(session.state, envelope.t === "ctrl")) {
          context.drop(session, 4413, "too large");
          return sequence(settleTransition);
        }
        if (envelope.t === "ctrl") message = parseCtrl(envelope.body);
      } catch {
        context.drop(session, 4400, "malformed");
        return sequence(settleTransition);
      }
      if (session.state === "unauth" && message?.type === "auth") authClaim(session, message);
      let needsPump = false;
      try {
        needsPump = await sequence(async () => {
          if (!current(session)) return false;
          const live = transport.session(connId);
          if (!live) return false;
          if (envelope.t !== "ctrl") {
            routeCiphertext(context, live, envelope, raw);
            // Successful forwarding changes no durable deadlines. Only routing
            // failures that drop a session need cleanup and alarm recalculation.
            if (disconnected.length) await settleTransition();
            return false;
          }
          if (!message) return false;
          if (live.state === "unauth") {
            if (message.type === "revocation-submit")
              await submitRevocation(context, live, envelope.from, message);
            else if (message.type !== "auth") context.drop(live, 4403, "auth required");
            else
              await authenticate(context, live, message, () =>
                ownsAuth(session, message as CtrlMessageOf<"auth">),
              );
          } else if (envelope.from !== live.fp) context.drop(live, 4403, "from mismatch");
          else if (live.state === "agent") needsPump = await agentControl(context, live, message);
          else if (live.state === "phone") await phoneControl(context, live, message);
          else await pairingControl(context, live, message);
          await settleTransition();
          return needsPump;
        });
      } catch (error) {
        if (error instanceof ProtocolError) context.drop(session, 4400, error.code);
        else {
          runtime.report("storage-failure");
          context.drop(session, 1011, "internal error");
        }
        return sequence(settleTransition);
      } finally {
        if (session.state === "unauth" && message?.type === "auth") {
          const key = claimKey(message.role, message.fp);
          if (claims.get(key) === token(session)) claims.delete(key);
        }
      }
      if (needsPump) await pump();
    },
    close(connId) {
      const session = transport.session(connId);
      if (!session) return Promise.resolve();
      // Retire synchronously before queued cleanup can see a replacement.
      context.drop(session, 1000, "closed");
      return sequence(settleTransition);
    },
    async wakeup(options) {
      const shouldPump = await sequence(async () => {
        const now = runtime.now();
        for (const s of sessions()) {
          if (
            (s.state === "unauth" && now - s.since >= UNAUTH_TIMEOUT_MS) ||
            (s.state === "pairing" && now - s.since >= PAIRING_TIMEOUT_MS)
          )
            context.drop(s, 4408, "timeout");
        }
        const window = await identity.window();
        if (window && now >= window.expiresAt) await identity.closeWindow();
        if (!context.agent() && (await identity.deleteExpiredComputer(now))) {
          for (const s of sessions()) context.drop(s, 4004, "computer expired");
          await settleTransition();
          return false;
        }
        if (!sessions().length && !(await identity.computer())) {
          await identity.deleteOrphanedComputer();
          await settleTransition();
          return false;
        }
        await settleTransition();
        return true;
      });
      if (shouldPump) {
        const task = pump();
        if (options) options.deferDelivery(task);
        else await task;
      }
    },
  };
}
