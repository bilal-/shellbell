import { randomBytes, type SessionChat, toBase64Url } from "@shellbell/protocol";
import type { ConversationReference } from "./reference.js";
import { createTranscriptIdentityProbe } from "./transcript-binding.js";
import type { TranscriptAgent } from "./transcript-file.js";
import type { TranscriptLocateResult, TranscriptLocator } from "./transcript-locator.js";

/** How often each session's chat status is proved again while a phone is connected. */
export const CHAT_STATUS_REFRESH_MS = 10_000;
/** A wait for the shared locator, or for an identity still settling. */
const RETRY_MS = 1000;
/** Covers both native proofs and the locator's own two-second limit. */
const PROBE_MS = 5000;
const TRANSCRIPT_AGENTS: ReadonlySet<string> = new Set<TranscriptAgent>([
  "claude",
  "codex",
  "agy",
  "gemini",
]);

export type ChatInputCheck = "ok" | "conversation-changed";

export interface ChatStatusOptions {
  /** The owner's conversation setting. While off, nothing is probed or published. */
  enabled(): boolean;
  /** Any phone connected: status is only proved while someone could see it. */
  active(): boolean;
  /** A phone shows this session now; its lookups go first. */
  viewed(sessionId: string): boolean;
  /** The session's terminal can name the agent conversation it runs. */
  supported(sessionId: string): boolean;
  /** Fresh native proof, the same one conversation reads use. */
  reference(sessionId: string, signal: AbortSignal): Promise<ConversationReference | null>;
  /** The shared locator, with its one-scan admission. */
  locator: Pick<TranscriptLocator, "locate">;
  /** A session's published status changed. */
  changed(): void;
  now?(): number;
  newId?(): string;
  refreshMs?: number;
}

/** One native ownership generation. Its key stays on the computer; only `id` is published. */
type Generation = { readonly id: string; readonly key: string };
interface Tracked {
  /** The agent kind the list last showed, kept after it exits. */
  agent: string;
  present: boolean;
  info: SessionChat;
  generation: Generation | null;
  due: number;
  /** Bumped by every change that makes an earlier probe's answer stale. */
  epoch: number;
  /** Probes since the last change that found no native identity yet. */
  unsettled: number;
}

const ownerKey = (reference: Pick<ConversationReference, "agent" | "owner">) =>
  `${reference.agent}\0${reference.owner}`;
const same = (a: SessionChat, b: SessionChat) =>
  a.state === b.state && a.id === b.id && a.agent === b.agent && a.reason === b.reason;

/**
 * Publishes, for each session running an agent, whether its chat can be found, before any phone
 * opens it. Each answer is a fresh native proof and locator lookup, never cached ownership, and
 * no conversation contents are read. A hint only: reads, deliveries and input prove again.
 */
export class ChatStatus {
  private readonly options: ChatStatusOptions;
  private readonly sessions = new Map<string, Tracked>();
  private timer: ReturnType<typeof setTimeout> | null = null;
  private probing: { sessionId: string; controller: AbortController } | null = null;
  private closed = false;

  constructor(options: ChatStatusOptions) {
    this.options = { ...options };
  }

  /** The status to publish with a session, or undefined for no agent or while disabled. */
  status(sessionId: string): SessionChat | undefined {
    if (this.closed || !this.options.enabled()) return undefined;
    return this.sessions.get(sessionId)?.info;
  }

  /** Every session list: notes agents starting, changing and exiting, and sessions ending. */
  update(list: readonly { id: string; agent?: { kind: string } }[]): void {
    if (this.closed) return;
    let changed = false;
    const listed = new Set<string>();
    for (const session of list) {
      listed.add(session.id);
      const tracked = this.sessions.get(session.id);
      const kind = session.agent?.kind;
      if (kind) {
        if (tracked?.present && tracked.agent === kind) continue;
        this.sessions.set(session.id, this.fresh(session.id, kind, tracked));
        changed = true;
      } else if (tracked?.present) {
        tracked.present = false;
        tracked.generation = null;
        tracked.epoch++;
        tracked.due = Infinity;
        this.cancel(session.id);
        changed ||= this.set(tracked, {
          state: "none",
          agent: tracked.agent,
          reason: "agent-exited",
        });
      }
    }
    for (const id of [...this.sessions.keys()])
      if (!listed.has(id)) {
        this.sessions.delete(id);
        this.cancel(id);
      }
    if (changed) this.notify();
    this.schedule();
  }

  /** A native change event: prove this session's chat again now. */
  invalidate(sessionId: string): void {
    const tracked = this.sessions.get(sessionId);
    if (this.closed || !tracked?.present || !this.lookable(sessionId, tracked.agent)) return;
    tracked.epoch++;
    tracked.unsettled = 0;
    tracked.due = this.now();
    this.cancel(sessionId);
    if (this.set(tracked, { state: "finding", agent: tracked.agent })) this.notify();
    this.schedule();
  }

  /** The session ended. */
  remove(sessionId: string): void {
    if (this.sessions.delete(sessionId)) this.cancel(sessionId);
  }

  /** Consent or phone presence changed. Turning off forgets every generation. */
  wake(): void {
    if (this.closed) return;
    if (!this.options.enabled()) {
      this.cancel();
      for (const [id, tracked] of this.sessions)
        if (tracked.present) this.sessions.set(id, this.fresh(id, tracked.agent, tracked));
        else this.sessions.delete(id);
    }
    this.schedule();
  }

  /**
   * Input from Chat: a fresh native proof that the session still holds the conversation the
   * phone shows. Any other answer ends that generation, so the status gets a new id.
   */
  async check(sessionId: string, chat: string, signal: AbortSignal): Promise<ChatInputCheck> {
    const tracked = this.sessions.get(sessionId);
    const generation = tracked?.generation;
    if (this.closed || !this.options.enabled() || !tracked || generation?.id !== chat)
      return "conversation-changed";
    const epoch = tracked.epoch;
    const reference = await this.options.reference(sessionId, signal).catch(() => null);
    const current =
      !this.closed &&
      this.options.enabled() &&
      this.sessions.get(sessionId) === tracked &&
      tracked.epoch === epoch &&
      tracked.generation === generation &&
      !signal.aborted;
    if (current && reference && ownerKey(reference) === generation.key) return "ok";
    if (this.sessions.get(sessionId) === tracked && tracked.generation === generation)
      this.invalidate(sessionId);
    return "conversation-changed";
  }

  close(): void {
    this.closed = true;
    this.cancel();
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.sessions.clear();
  }

  private fresh(sessionId: string, agent: string, previous?: Tracked): Tracked {
    if (previous) this.cancel(sessionId);
    const lookable = this.lookable(sessionId, agent);
    return {
      agent,
      present: true,
      info: lookable
        ? { state: "finding", agent }
        : { state: "none", agent, reason: "not-supported" },
      generation: null,
      due: lookable ? this.now() : Infinity,
      epoch: (previous?.epoch ?? 0) + 1,
      unsettled: 0,
    };
  }

  private lookable(sessionId: string, agent: string): boolean {
    return TRANSCRIPT_AGENTS.has(agent) && this.options.supported(sessionId);
  }

  private set(tracked: Tracked, info: SessionChat): boolean {
    if (same(tracked.info, info)) return false;
    tracked.info = info;
    return true;
  }

  private notify(): void {
    if (this.options.enabled()) this.options.changed();
  }

  private now(): number {
    return this.options.now?.() ?? Date.now();
  }

  private cancel(sessionId?: string): void {
    if (this.probing && (sessionId === undefined || this.probing.sessionId === sessionId)) {
      this.probing.controller.abort();
      this.probing = null;
    }
  }

  private schedule(): void {
    if (this.closed || this.probing) return;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    if (!this.options.enabled() || !this.options.active()) return;
    let next = Infinity;
    for (const tracked of this.sessions.values()) next = Math.min(next, tracked.due);
    if (next === Infinity) return;
    this.timer = setTimeout(
      () => {
        this.timer = null;
        this.pump();
      },
      Math.max(0, next - this.now()),
    );
    this.timer.unref?.();
  }

  /** One lookup at a time: the next due session, viewed sessions first. */
  private pump(): void {
    if (this.closed || this.probing || !this.options.enabled() || !this.options.active()) return;
    const now = this.now();
    let chosen: [string, Tracked] | null = null;
    for (const entry of this.sessions) {
      const [id, tracked] = entry;
      if (tracked.due > now) continue;
      if (!chosen) {
        chosen = entry;
        continue;
      }
      const viewed = this.options.viewed(id);
      const chosenViewed = this.options.viewed(chosen[0]);
      if (viewed !== chosenViewed ? viewed : tracked.due < chosen[1].due) chosen = entry;
    }
    if (!chosen) {
      this.schedule();
      return;
    }
    const [sessionId, tracked] = chosen;
    const controller = new AbortController();
    const probing = { sessionId, controller };
    this.probing = probing;
    void this.probe(sessionId, tracked, controller.signal).finally(() => {
      if (this.probing === probing) this.probing = null;
      this.schedule();
    });
  }

  private async probe(sessionId: string, tracked: Tracked, signal: AbortSignal): Promise<void> {
    const epoch = tracked.epoch;
    const current = () =>
      !this.closed &&
      !signal.aborted &&
      this.options.enabled() &&
      this.sessions.get(sessionId) === tracked &&
      tracked.epoch === epoch;
    let referenced: ConversationReference | null | undefined;
    let located: TranscriptLocateResult | undefined;
    const prove = createTranscriptIdentityProbe({
      enabled: current,
      reference: async (inner) => {
        const reference = await this.options.reference(sessionId, inner);
        if (referenced === undefined) referenced = reference;
        return reference;
      },
      locator: {
        locate: async (reference, inner) => {
          located = await this.options.locator.locate(reference, inner);
          return located;
        },
      },
    });
    const controller = new AbortController();
    const deadline = setTimeout(() => controller.abort(), PROBE_MS);
    const stop = () => controller.abort();
    signal.addEventListener("abort", stop, { once: true });
    let identity: Awaited<ReturnType<typeof prove>>;
    try {
      identity = await prove(controller.signal);
    } finally {
      clearTimeout(deadline);
      signal.removeEventListener("abort", stop);
    }
    if (!current()) return;
    const now = this.now();
    const refresh = now + (this.options.refreshMs ?? CHAT_STATUS_REFRESH_MS);
    const retry = () => {
      tracked.due = now + RETRY_MS;
    };
    let info: SessionChat | null = null;
    if (identity) {
      const key = ownerKey(identity);
      if (tracked.generation?.key !== key) tracked.generation = { id: this.newId(), key };
      tracked.unsettled = 0;
      info = { state: "found", id: tracked.generation.id, agent: identity.agent };
    } else if (located?.status === "busy") retry();
    else if (referenced === null) {
      // An identity can settle a moment after a change, such as a Herdr snapshot; say so only
      // once a second proof agrees.
      tracked.generation = null;
      if (tracked.info.state === "finding" && tracked.unsettled++ === 0) retry();
      else info = { state: "none", agent: tracked.agent, reason: "no-history" };
    } else if (located?.status === "unavailable") {
      const reason = located.reason;
      if (reason === "limit" || reason === "ambiguous" || reason === "unbound") {
        tracked.generation = null;
        info = {
          state: "none",
          agent: tracked.agent,
          reason:
            reason === "limit"
              ? "lookup-limit"
              : reason === "ambiguous"
                ? "ambiguous"
                : "no-history",
        };
      } else retry();
    } else retry();
    if (info) {
      tracked.due = refresh;
      if (this.set(tracked, info)) this.notify();
    }
  }

  private newId(): string {
    const id = this.options.newId?.() ?? toBase64Url(randomBytes(16));
    if (id.length < 1 || id.length > 32) throw new TypeError("Invalid chat id");
    return id;
  }
}
