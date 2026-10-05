import {
  type CtrlMessage,
  deriveNotificationKey,
  fromBase64Url,
  MAX_PAIRINGS,
  NOTIFICATION_LIMITS,
  type NotificationBox,
  type NotificationPayload,
  NotificationPayloadSchema,
  randomBytes,
  sealNotification,
  toBase64Url,
} from "@shellbell/protocol";
import type { Ring } from "./events.js";
import {
  type GitContextReader,
  type NotificationFacts,
  resolveNotificationContext,
} from "./notification-context.js";
import type { NotificationState } from "./notification-state.js";

interface Options {
  state: NotificationState;
  computerFp: string;
  computerName: () => string;
  now?: () => number;
  capable: () => boolean;
  pairings: () => readonly { phoneFp: string; kPair: string }[];
  facts: (sessionId: string) => Promise<NotificationFacts | undefined>;
  git: GitContextReader;
}
export function genericNotification(ring: Ring): CtrlMessage {
  return {
    type: "notify",
    sessionId: ring.sessionId,
    kind: ring.kind,
    exitCode: ring.exitCode,
    durationMs: ring.durationMs,
  };
}
function fitPayload(payload: NotificationPayload): NotificationPayload | undefined {
  const candidate = { ...payload, context: { ...payload.context } };
  for (const field of [
    "branch",
    "title",
    "agentName",
    "shell",
    "customName",
    "repository",
  ] as const) {
    if (NotificationPayloadSchema.safeParse(candidate).success) return candidate;
    delete candidate.context[field];
  }
  return NotificationPayloadSchema.safeParse(candidate).success ? candidate : undefined;
}
/** Context is captured per logical event, never cached as relay-readable metadata. */
export class NotificationDispatcher {
  private readonly cache = new WeakMap<Ring, () => Promise<CtrlMessage>>();
  constructor(private readonly options: Options) {}
  prepare(ring: Ring): Promise<CtrlMessage> {
    const previous = this.cache.get(ring);
    if (previous) return previous();
    const owners = new Map(this.options.pairings().map((p) => [p.phoneFp, p.kPair]));
    const created = (this.options.now ?? Date.now)();
    let cancelled = false;
    const started = performance.now();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<CtrlMessage>((resolve) => {
      timer = setTimeout(() => {
        cancelled = true;
        resolve(genericNotification(ring));
      }, 250);
    });
    const expired = () => cancelled || performance.now() - started >= 250;
    const pending = Promise.race([this.build(ring, expired, created), deadline])
      .catch(() => genericNotification(ring))
      .finally(() => clearTimeout(timer));
    const guarded = () =>
      pending.then((message) => {
        const now = (this.options.now ?? Date.now)();
        if (message.type !== "notify-context") return message;
        if (
          !this.options.capable() ||
          now < created ||
          now - created >= NOTIFICATION_LIMITS.freshnessMs
        )
          return genericNotification(ring);
        const paired = this.options.pairings();
        const boxes = message.boxes.filter(
          (box) =>
            this.options.state.owns(box.phoneFp, box.generation) &&
            paired.some((p) => p.phoneFp === box.phoneFp && p.kPair === owners.get(box.phoneFp)),
        );
        return boxes.length ? { ...message, boxes } : genericNotification(ring);
      });
    // Cache the original encrypted event, but re-check revocation on every retry.
    this.cache.set(ring, guarded);
    return guarded();
  }
  private async build(
    ring: Ring,
    cancelled: () => boolean,
    createdAt: number,
  ): Promise<CtrlMessage> {
    const o = this.options,
      now = o.now ?? Date.now;
    const generic = genericNotification(ring);
    if (!o.capable() || !ring.reason) return generic;
    const eventId = toBase64Url(randomBytes(16));
    const pairings = o.pairings().slice(0, MAX_PAIRINGS);
    const facts = await o.facts(ring.sessionId);
    if (!facts || cancelled()) return generic;
    const current = async () => {
      const latest = await o.facts(ring.sessionId);
      return latest?.revision === facts.revision && latest.sessionId === facts.sessionId;
    };
    const context = await resolveNotificationContext(facts, {
      computerName: o.computerName(),
      now,
      stillCurrent: current,
      git: o.git,
    });
    if (cancelled() || !o.capable() || !(await current()) || cancelled()) return generic;
    // Context observation occurs during discovery. Issue the envelope afterwards,
    // while retaining the event's original expiry so discovery cannot extend it.
    const issuedAt = now();
    if (
      issuedAt - createdAt >= NOTIFICATION_LIMITS.freshnessMs ||
      issuedAt < createdAt ||
      issuedAt < context.observedAt
    )
      return generic;
    const boxes: NotificationBox[] = [];
    const message: Extract<CtrlMessage, { type: "notify-context" }> = {
      type: "notify-context",
      sessionId: ring.sessionId,
      eventId,
      kind: ring.kind,
      exitCode: ring.exitCode,
      durationMs: ring.durationMs,
      boxes,
    };
    for (const pairing of pairings) {
      if (cancelled()) break;
      if (!o.pairings().some((p) => p.phoneFp === pairing.phoneFp && p.kPair === pairing.kPair))
        continue;
      // A lost/failed durable reservation must never be followed by encryption.
      const reserved = o.state.reserve(pairing.phoneFp);
      if (!reserved) continue;
      const payload = fitPayload({
        computerFp: o.computerFp,
        phoneFp: pairing.phoneFp,
        generation: reserved.generation,
        sessionId: ring.sessionId,
        eventId,
        sequence: reserved.sequence,
        issuedAt,
        expiresAt: createdAt + NOTIFICATION_LIMITS.freshnessMs,
        reason: ring.reason,
        context,
        exitCode: ring.exitCode,
        durationMs: ring.durationMs,
      });
      if (!payload) continue;
      let pairKey: Uint8Array | undefined, notificationKey: Uint8Array | undefined;
      try {
        pairKey = fromBase64Url(pairing.kPair);
        notificationKey = deriveNotificationKey(pairKey, payload);
        boxes.push(sealNotification(notificationKey, payload));
        if (Buffer.byteLength(JSON.stringify(message), "utf8") > 16_384) boxes.pop();
      } catch {
        /* Generic fallback for this recipient; no private values in logs. */
      } finally {
        pairKey?.fill(0);
        notificationKey?.fill(0);
      }
    }
    return boxes.length ? message : generic;
  }
}
