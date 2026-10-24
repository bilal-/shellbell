import { homedir } from "node:os";
import { join } from "node:path";
import {
  CONVERSATION_LIMITS,
  type ConversationMessage,
  ConversationMessageSchema,
  MAX_PAIRINGS,
  randomBytes,
  toBase64Url,
} from "@shellbell/protocol";
import type { BackendRegistry } from "../backends/registry.js";
import type { ServiceViewLease } from "../service-view-coordinator.js";
import { AgentConversationStream } from "./agent-conversation-stream.js";
import { createTranscriptIdentityProbe } from "./transcript-binding.js";
import type { TranscriptFileOptions } from "./transcript-file.js";
import { TranscriptFollowers } from "./transcript-follower.js";
import { TranscriptLocator } from "./transcript-locator.js";

export interface ConversationLease {
  focus(sessionId: string): void;
  receive(message: ConversationMessage, envelopeBytes: number): void;
  close(): void;
}
interface Entry {
  focused: string | null;
  source: AgentConversationStream | null;
  current(): boolean;
  send(message: ConversationMessage): boolean;
  lane: ReturnType<ServiceViewLease["background"]>;
}
export interface ConversationCoordinatorOptions {
  backend: BackendRegistry;
  enabled(): boolean;
  roots?: TranscriptFileOptions["roots"];
  followers?: Pick<TranscriptFollowers, "create" | "close">;
  locator?: Pick<TranscriptLocator, "locate">;
  now?: () => number;
  newId?: () => string;
}

/** One shared reader pool/locator and fair work queue for all paired-phone routes. */
export class ConversationCoordinator {
  private readonly options: ConversationCoordinatorOptions;
  private readonly roots: TranscriptFileOptions["roots"];
  private readonly followers: Pick<TranscriptFollowers, "create" | "close">;
  private readonly locator: Pick<TranscriptLocator, "locate">;
  private readonly entries = new Set<Entry>();
  private readonly off: () => void;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private working: object | null = null;
  private closed = false;

  constructor(options: ConversationCoordinatorOptions) {
    this.options = { ...options };
    this.roots = options.roots ?? {
      claude: [join(process.env.CLAUDE_CONFIG_DIR || join(homedir(), ".claude"), "projects")],
      codex: [join(process.env.CODEX_HOME || join(homedir(), ".codex"), "sessions")],
      agy: [join(homedir(), ".gemini", "antigravity-cli", "conversations")],
    };
    this.followers = options.followers ?? new TranscriptFollowers();
    this.locator =
      options.locator ??
      new TranscriptLocator({
        roots: this.roots,
        enabled: () => !this.closed && this.options.enabled(),
      });
    this.off = options.backend.on((event) => {
      if (event.type !== "conversation-changed" && event.type !== "session-removed") return;
      for (const entry of this.entries) {
        if (entry.source?.sessionId !== event.sessionId) continue;
        entry.source.invalidate(event.type === "session-removed" ? "ended" : "changed");
      }
      this.schedule();
    });
  }

  attach(route: {
    current(): boolean;
    send(message: ConversationMessage): boolean;
    background: ServiceViewLease["background"];
  }): ConversationLease {
    if (this.closed || this.entries.size >= MAX_PAIRINGS)
      return { focus() {}, receive() {}, close() {} };
    const entry: Entry = {
      focused: null,
      source: null,
      current: route.current,
      send: route.send,
      lane: route.background(() =>
        this.current(entry) ? (entry.source?.offer() ?? false) : false,
      ),
    };
    this.entries.add(entry);
    return {
      focus: (sessionId) => {
        if (!this.current(entry) || entry.focused === sessionId) return;
        entry.focused = sessionId;
        entry.source?.close();
        entry.source = null;
      },
      receive: (message, envelopeBytes) => {
        if (!this.current(entry)) return;
        const parsed = ConversationMessageSchema.safeParse(message);
        if (
          !parsed.success ||
          !Number.isSafeInteger(envelopeBytes) ||
          envelopeBytes < 1 ||
          envelopeBytes > CONVERSATION_LIMITS.envelopeBytes
        )
          return;
        message = parsed.data;
        if (message.type === "conversation.subscribe") {
          if (entry.source?.subscriptionId === message.subscriptionId) return;
          entry.source?.close();
          entry.source = null;
          const sessionId = message.sessionId;
          // Conversation remains usable when the terminal renderer cannot subscribe.
          // This authenticated request owns the route's one focused conversation.
          entry.focused = sessionId;
          let source: AgentConversationStream;
          const enabled = () =>
            this.current(entry) &&
            entry.source === source &&
            entry.focused === sessionId &&
            this.options.enabled();
          source = new AgentConversationStream({
            subscriptionId: message.subscriptionId,
            sessionId,
            now: () => this.options.now?.() ?? performance.now(),
            newId: () => this.options.newId?.() ?? toBase64Url(randomBytes(16)),
            enabled,
            follow: () =>
              this.followers.create({
                enabled,
                roots: this.roots,
                identity: createTranscriptIdentityProbe({
                  enabled,
                  locator: this.locator,
                  reference: (signal) =>
                    this.options.backend.conversationReference(sessionId, signal),
                }),
              }),
            send: (frame) => this.current(entry) && entry.source === source && entry.send(frame),
            wake: () => entry.lane.wake(),
          });
          entry.source = source;
          if (!this.options.enabled()) source.invalidate("disabled");
          entry.lane.wake();
        } else {
          entry.source?.receive(message, envelopeBytes);
          if (
            message.type === "conversation.cancel" &&
            entry.source?.subscriptionId === message.subscriptionId
          )
            entry.source = null;
        }
        this.schedule();
      },
      close: () => this.retire(entry),
    };
  }

  /** Called synchronously for every local opt-out path, including stale or unreadable config. */
  consentChanged(): void {
    if (this.closed) return;
    for (const entry of this.entries)
      if (entry.source) entry.source.invalidate(this.options.enabled() ? "changed" : "disabled");
    this.schedule();
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.off();
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    for (const entry of this.entries) this.retire(entry);
    this.followers.close();
  }

  private current(entry: Entry): boolean {
    return !this.closed && this.entries.has(entry) && entry.current();
  }
  private retire(entry: Entry): void {
    if (!this.entries.delete(entry)) return;
    entry.source?.close();
    entry.source = null;
    entry.lane.close();
  }
  /** Work that is already due, such as a reader catching up, runs on the next turn. */
  private schedule(soon = false): void {
    if (this.closed || ![...this.entries].some((entry) => entry.source)) return;
    if (this.timer) {
      if (!soon) return;
      clearTimeout(this.timer);
    }
    this.timer = setTimeout(
      () => {
        this.timer = null;
        this.pump();
      },
      soon ? 0 : 200,
    );
    this.timer.unref?.();
  }
  private pump(): void {
    if (this.closed) return;
    for (const entry of this.entries) {
      if (!entry.current()) this.retire(entry);
      else entry.source?.tick();
    }
    if (!this.working) {
      const entry = [...this.entries].find((value) => value.source?.needsWork);
      if (entry?.source) {
        this.entries.delete(entry);
        this.entries.add(entry);
        const operation = {};
        this.working = operation;
        void entry.source.work().finally(() => {
          if (this.working === operation) this.working = null;
          this.schedule([...this.entries].some((value) => value.source?.needsWork));
        });
      }
    }
    this.schedule();
  }
}
