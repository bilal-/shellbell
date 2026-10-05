import type { SessionRecord } from "../session.js";

/**
 * Assign a fresh connId to every accepted socket, never reuse IDs for later sockets.
 * close() synchronously removes that socket from sessions(), then closes its transport.
 * For an incoming close/error, call core.close(connId) before removing its saved session.
 * Late callbacks carry the old connId and cannot affect the replacement's different ID.
 */
export interface RelayTransport {
  /** Both lookup and enumeration return detached records, never mutable runtime state. */
  session(connId: string): SessionRecord | undefined;
  sessions(): readonly SessionRecord[];
  save(session: SessionRecord): void;
  send(connId: string, bytes: Uint8Array): "sent" | "overloaded" | "closed";
  close(connId: string, code: number, reason: string): void;
}
export interface WakeupScheduler {
  /** Raw earliest deadline; adapters own timer floors and persisted-alarm preservation. */
  replace(deadline: number | null): Promise<void>;
}
