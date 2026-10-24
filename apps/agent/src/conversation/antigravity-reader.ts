import { createHash } from "node:crypto";
import { lstat, realpath } from "node:fs/promises";
import { basename, dirname, sep } from "node:path";
import { type AntigravityStep, antigravityEntries } from "./antigravity.js";
import type { ConversationSnapshot } from "./transcript-document.js";
import type { TranscriptFileOptions, TranscriptIdentity } from "./transcript-file.js";

/** Newest steps read per change; older ones are summarised as not loaded. */
export const ANTIGRAVITY_STEPS = 2000;
/** A step row larger than this is shown as a notice instead of being read. */
const STEP_BYTES = 1024 * 1024;
const ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

interface Database {
  prepare(sql: string): {
    all(...values: unknown[]): unknown[];
    get(...values: unknown[]): unknown;
  };
  close(): void;
}
type Open = (path: string) => Database;

let loading: Promise<Open | null> | null = null;
/** Node's SQLite ships unflagged from 22.13; older runtimes keep the Terminal view. */
function sqlite(): Promise<Open | null> {
  loading ??= (async () => {
    // The module warns that it is experimental on first load. That warning is for developers.
    const emit = process.emitWarning;
    process.emitWarning = ((warning: string | Error, ...rest: unknown[]) => {
      const text = typeof warning === "string" ? warning : warning.message;
      if (/SQLite/i.test(text)) return;
      return (emit as (...args: unknown[]) => void).call(process, warning, ...rest);
    }) as typeof process.emitWarning;
    try {
      const { DatabaseSync } = await import("node:sqlite");
      return (path: string) => new DatabaseSync(path, { readOnly: true }) as unknown as Database;
    } catch {
      return null;
    } finally {
      process.emitWarning = emit;
    }
  })();
  return loading;
}

export type AntigravityRead =
  | { readonly status: "snapshot"; readonly snapshot: Readonly<ConversationSnapshot> }
  | {
      readonly status: "stopped";
      readonly reason: "unbound" | "unsafe" | "unsupported" | "changed" | "unreadable";
    };

/**
 * Reads one proven Antigravity conversation database, read-only. Unlike JSONL transcripts the
 * database changes in place, so each read renews the pane's native proof and the file's
 * identity, and re-reads the newest steps only when SQLite reports a change.
 */
export class AntigravityReader {
  private database: Database | null = null;
  private inode: { dev: number; ino: number } | null = null;
  private version: unknown = undefined;
  private latest: Readonly<ConversationSnapshot> | null = null;
  private hash = "";
  private revision = 0;

  constructor(
    private readonly options: TranscriptFileOptions,
    private readonly identity: Readonly<TranscriptIdentity>,
  ) {}

  /** The native proof and file must still be the ones first opened. */
  private async proven(signal: AbortSignal): Promise<AntigravityRead | null> {
    const now = await this.options.identity(signal);
    if (
      now?.agent !== "agy" ||
      now.path !== this.identity.path ||
      now.session !== this.identity.session ||
      now.owner !== this.identity.owner
    )
      return { status: "stopped", reason: "changed" };
    const stat = await lstat(this.identity.path);
    if (
      !stat.isFile() ||
      stat.isSymbolicLink() ||
      (process.getuid && stat.uid !== process.getuid())
    )
      return { status: "stopped", reason: "unsafe" };
    if (this.inode && (stat.dev !== this.inode.dev || stat.ino !== this.inode.ino))
      return { status: "stopped", reason: "changed" };
    this.inode = { dev: stat.dev, ino: stat.ino };
    return null;
  }

  private async open(): Promise<AntigravityRead | null> {
    const { path, session } = this.identity;
    if (!ID.test(session) || basename(path) !== `${session}.db`)
      return { status: "stopped", reason: "unsafe" };
    const roots = this.options.roots.agy ?? [];
    let allowed = false;
    for (const root of roots) {
      try {
        const real = await realpath(root);
        if (dirname(path) === real || dirname(path) === `${real}${sep}`.slice(0, -1))
          allowed = true;
      } catch {
        /* absent optional root */
      }
    }
    if (!allowed || (await realpath(path)) !== path) return { status: "stopped", reason: "unsafe" };
    const open = await sqlite();
    if (!open) return { status: "stopped", reason: "unsupported" };
    this.database = open(path);
    return null;
  }

  async read(signal: AbortSignal): Promise<AntigravityRead> {
    try {
      const proof = await this.proven(signal);
      if (proof) return proof;
      if (!this.database) {
        const opened = await this.open();
        if (opened) return opened;
      }
      const database = this.database!;
      // `data_version` changes only when another connection commits, so idle polls are cheap.
      const version = (database.prepare("PRAGMA data_version").get() as { data_version: number })
        .data_version;
      if (this.latest && version === this.version) {
        if (this.latest.change !== "unchanged")
          this.latest = Object.freeze({ ...this.latest, change: "unchanged" });
        return { status: "snapshot", snapshot: this.latest };
      }
      const rows = database
        .prepare(
          `SELECT idx, step_type AS type, status,
             CASE WHEN length(step_payload) <= ? THEN step_payload END AS payload
           FROM steps ORDER BY idx DESC LIMIT ?`,
        )
        .all(STEP_BYTES, ANTIGRAVITY_STEPS + 1) as {
        idx: number;
        type: number;
        status: number;
        payload: Uint8Array | null;
      }[];
      const truncated = rows.length > ANTIGRAVITY_STEPS;
      const steps: AntigravityStep[] = rows
        .slice(0, ANTIGRAVITY_STEPS)
        .reverse()
        .map((row) => ({
          idx: Number(row.idx),
          type: Number(row.type),
          status: Number(row.status),
          payload: row.payload,
        }));
      const after = await this.proven(signal);
      if (after) return after;
      const entries = antigravityEntries(steps);
      if (truncated)
        entries.unshift(
          Object.freeze({
            id: "history:unloaded",
            kind: "status",
            text: "Earlier conversation is not loaded.",
          }),
        );
      const hash = createHash("sha256").update(JSON.stringify(entries)).digest("base64url");
      const changed = hash !== this.hash;
      if (changed) this.revision++;
      this.hash = hash;
      this.version = version;
      const snapshot: Readonly<ConversationSnapshot> = Object.freeze({
        state: "ready",
        entries: Object.freeze(entries),
        history: truncated ? "unloaded" : "complete",
        change: changed ? "replace" : "unchanged",
        revision: this.revision,
        branch: Object.freeze({ kind: "rows" as const }),
      });
      this.latest = snapshot;
      return { status: "snapshot", snapshot };
    } catch {
      // SQLite errors can name paths or contents. Keep only a fixed reason.
      return { status: "stopped", reason: "unreadable" };
    }
  }

  /** Whether the database has changed since the last read; null if proof failed. */
  async changed(signal: AbortSignal): Promise<boolean | null> {
    try {
      if ((await this.proven(signal)) || !this.database) return null;
      const version = (
        this.database.prepare("PRAGMA data_version").get() as {
          data_version: number;
        }
      ).data_version;
      return version !== this.version;
    } catch {
      return null;
    }
  }

  close(): void {
    try {
      this.database?.close();
    } catch {
      /* already closed */
    }
    this.database = null;
    this.latest = null;
  }
}
