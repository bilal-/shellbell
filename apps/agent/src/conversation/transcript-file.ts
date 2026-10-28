import type { EventEmitter } from "node:events";
import { constants, type Stats } from "node:fs";
import { type FileHandle, lstat, open, realpath } from "node:fs/promises";
import { isAbsolute, relative, sep } from "node:path";

/** `agy` is Antigravity CLI, whose conversations are SQLite databases rather than JSONL. */
export type TranscriptAgent = "claude" | "codex" | "agy" | "gemini";
/** Where each agent keeps its conversations. Antigravity's and Gemini's are optional. */
export type TranscriptRoots = Readonly<Record<"claude" | "codex", readonly string[]>> & {
  readonly agy?: readonly string[];
  readonly gemini?: readonly string[];
};

/** Internal adapter evidence, never a path or identity supplied by a phone. */
export interface TranscriptIdentity {
  readonly agent: TranscriptAgent;
  readonly path: string;
  readonly session: string;
  /** Changes on pane replacement, process restart or an explicit session switch. */
  readonly owner: string;
}
export type TranscriptStop =
  | "disabled"
  | "unbound"
  | "changed"
  | "unreadable"
  | "unsafe"
  | "cancelled";
export type TranscriptRead =
  | { status: "data"; bytes: Uint8Array; offset: number; size: number }
  | { status: "busy" }
  | { status: "stopped"; reason: TranscriptStop };
export const TRANSCRIPT_READ_BYTES = 64 * 1024;
const FENCE_BYTES = 4096;
const PROOF_MS = 2000;

export interface TranscriptFileOptions {
  /** Owner opt-in is rechecked before and after every read. Default-off at the caller. */
  enabled: () => boolean;
  /** Fresh native identity/process evidence; implementations must honor cancellation. */
  identity: (signal: AbortSignal) => Promise<TranscriptIdentity | null>;
  roots: TranscriptRoots;
  signal?: AbortSignal;
}
interface Fence {
  offset: number;
  bytes: Buffer;
}
function sameIdentity(a: TranscriptIdentity, b: TranscriptIdentity | null): boolean {
  return (
    !!b &&
    a.agent === b.agent &&
    a.path === b.path &&
    a.session === b.session &&
    a.owner === b.owner
  );
}
function sameFile(a: Stats, b: Stats): boolean {
  return a.dev === b.dev && a.ino === b.ino;
}
function safePath(path: string): boolean {
  return (
    isAbsolute(path) &&
    path.length <= 4096 &&
    !Array.from(path).some(
      (character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127,
    )
  );
}
function inside(root: string, path: string): boolean {
  const part = relative(root, path);
  return part !== "" && part !== ".." && !part.startsWith(`..${sep}`) && !isAbsolute(part);
}
function fileAllowed(stat: Stats): boolean {
  return (
    stat.isFile() &&
    !stat.isSymbolicLink() &&
    Number.isSafeInteger(stat.size) &&
    stat.size >= 0 &&
    (process.getuid === undefined || stat.uid === process.getuid())
  );
}

/** A failed close keeps its admission until Node confirms the descriptor actually closed. */
function closeDescriptor(file: FileHandle): Promise<void> {
  if (file.fd === -1) return Promise.resolve();
  // Node FileHandle emits close; the installed Node typings omit its EventEmitter members.
  const events = file as FileHandle & Pick<EventEmitter, "once" | "removeListener">;
  return new Promise((resolve) => {
    let settled = false;
    const check = () => {
      if (!settled || file.fd !== -1) return;
      events.removeListener("close", check);
      resolve();
    };
    const finish = () => {
      settled = true;
      check();
    };
    events.once("close", check);
    try {
      void file.close().then(finish, finish);
    } catch {
      finish();
    }
  });
}

/** One proven, read-only descriptor. Invalidated generations never yield more bytes. */
export class TranscriptFile {
  readonly identity: Readonly<TranscriptIdentity>;
  private readonly controller = new AbortController();
  private reason: TranscriptStop | null = null;
  private reading = false;
  private opening = true;
  private closeFinished = false;
  private finishClosed!: () => void;
  /** Resolves only after closing the descriptor and all owned open/read/verify work settles. */
  readonly closed = new Promise<void>((resolve) => {
    this.finishClosed = resolve;
  });
  private fences: Fence[] = [];
  private observed: Stats;
  private readonly onAbort = () => {
    this.stop("cancelled");
  };

  private constructor(
    private readonly options: TranscriptFileOptions,
    identity: TranscriptIdentity,
    private readonly path: string,
    private readonly file: FileHandle,
    stat: Stats,
  ) {
    this.identity = Object.freeze({ ...identity });
    this.observed = stat;
    options.signal?.addEventListener("abort", this.onAbort, { once: true });
    if (options.signal?.aborted) this.stop("cancelled");
  }

  static async open(
    options: TranscriptFileOptions,
  ): Promise<
    { status: "open"; file: TranscriptFile } | { status: "stopped"; reason: TranscriptStop }
  > {
    let file: FileHandle | undefined;
    let reader: TranscriptFile | undefined;
    try {
      if (options.signal?.aborted) return { status: "stopped", reason: "cancelled" };
      if (!options.enabled()) return { status: "stopped", reason: "disabled" };
      const sampled = await proof(options, options.signal);
      if (!sampled)
        return { status: "stopped", reason: options.signal?.aborted ? "cancelled" : "unbound" };
      const identity = { ...sampled };
      if (
        !["claude", "codex", "gemini"].includes(identity.agent) ||
        !safePath(identity.path) ||
        !identity.path.endsWith(".jsonl") ||
        !/^[a-zA-Z0-9][a-zA-Z0-9_.:-]{0,255}$/.test(identity.session) ||
        !identity.owner ||
        identity.owner.length > 1024
      )
        return { status: "stopped", reason: "unsafe" };
      const roots = options.roots[identity.agent];
      if (!roots?.length || roots.length > 8) return { status: "stopped", reason: "unsafe" };
      const path = await realpath(identity.path);
      let allowed = false;
      for (const root of roots) {
        if (!safePath(root)) continue;
        try {
          if (inside(await realpath(root), path)) allowed = true;
        } catch {
          /* absent optional root */
        }
      }
      if (!allowed) return { status: "stopped", reason: "unsafe" };
      // Reject even a final symlink into an approved directory. The adapter must provide its real path.
      const before = await lstat(identity.path);
      if (!fileAllowed(before)) return { status: "stopped", reason: "unsafe" };
      file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
      const opened = await file.stat();
      if (!fileAllowed(opened) || !sameFile(before, opened))
        return { status: "stopped", reason: "changed" };
      reader = new TranscriptFile(options, identity, path, file, opened);
      const valid = await reader.validate();
      if (valid) return { status: "stopped", reason: valid };
      if (!reader.installFences(await reader.captureFences(opened.size)))
        return { status: "stopped", reason: reader.stopped! };
      const after = (await reader.validate()) ?? reader.availability();
      if (after) return { status: "stopped", reason: after };
      file = undefined; // Ownership moved to the open reader.
      return { status: "open", file: reader };
    } catch {
      return { status: "stopped", reason: options.signal?.aborted ? "cancelled" : "unreadable" };
    } finally {
      if (reader) {
        if (file) reader.stop("unreadable");
        reader.opening = false;
        reader.finishClosing();
        if (file) await reader.closed;
      } else if (file) {
        await closeDescriptor(file);
      }
    }
  }

  get stopped(): TranscriptStop | null {
    return this.reason;
  }
  get size(): number {
    return this.observed.size;
  }

  /** Callers page/parse these bounded windows; no unbounded readFile or read queue. */
  async read(offset: number, length = TRANSCRIPT_READ_BYTES): Promise<TranscriptRead> {
    if (this.reason) return { status: "stopped", reason: this.reason };
    if (this.reading) return { status: "busy" };
    if (
      !Number.isSafeInteger(offset) ||
      offset < 0 ||
      !Number.isSafeInteger(length) ||
      length < 1 ||
      length > TRANSCRIPT_READ_BYTES
    ) {
      this.stop("unsafe");
      return { status: "stopped", reason: "unsafe" };
    }
    this.reading = true;
    let bytes: Buffer | undefined;
    let pendingFences: Fence[] | undefined;
    try {
      const before = await this.validate();
      if (before) return this.stoppedRead(before);
      const size = this.observed.size;
      if (offset > size) return this.stoppedRead("unsafe");
      bytes = Buffer.alloc(Math.min(length, size - offset));
      const { bytesRead } = await this.file.read(bytes, 0, bytes.length, offset);
      if (bytesRead !== bytes.length) return this.stoppedRead("changed");
      // Keep the old fences until both sets validate. Replacing them before validation
      // could accidentally accept a rewrite that occurs while capturing the new set.
      pendingFences = await this.captureFences(size);
      const committed = await this.validate(pendingFences);
      if (committed) return this.stoppedRead(committed);
      if (!this.installFences(pendingFences)) return this.stoppedRead(this.reason!);
      pendingFences = undefined;
      const result = bytes;
      bytes = undefined;
      return { status: "data", bytes: result, offset, size };
    } catch {
      return this.stoppedRead(this.reason ?? "unreadable");
    } finally {
      bytes?.fill(0);
      for (const fence of pendingFences ?? []) fence.bytes.fill(0);
      this.reading = false;
      this.finishClosing();
    }
  }

  /** Renew ownership, descriptor and sampled rewrite-fence checks without exposing file bytes. */
  async verify(): Promise<
    { status: "verified"; size: number } | Exclude<TranscriptRead, { status: "data" }>
  > {
    if (this.reason) return { status: "stopped", reason: this.reason };
    if (this.reading) return { status: "busy" };
    this.reading = true;
    try {
      const reason = (await this.validate()) ?? this.availability();
      if (reason) {
        this.stop(reason);
        return { status: "stopped", reason: this.reason! };
      }
      return { status: "verified", size: this.observed.size };
    } catch {
      this.stop(this.reason ?? "unreadable");
      return { status: "stopped", reason: this.reason! };
    } finally {
      this.reading = false;
      this.finishClosing();
    }
  }

  close(): void {
    this.stop("cancelled");
  }

  private stoppedRead(reason: TranscriptStop): TranscriptRead {
    this.stop(reason);
    return { status: "stopped", reason: this.reason! };
  }
  private stop(reason: TranscriptStop): void {
    if (this.reason) return;
    this.reason = reason;
    this.controller.abort();
    this.options.signal?.removeEventListener("abort", this.onAbort);
    for (const fence of this.fences) fence.bytes.fill(0);
    this.fences = [];
    void closeDescriptor(this.file).then(() => {
      this.closeFinished = true;
      this.finishClosing();
    });
  }
  private finishClosing(): void {
    if (this.reason && this.closeFinished && !this.opening && !this.reading) this.finishClosed();
  }
  private async validate(pendingFences: readonly Fence[] = []): Promise<TranscriptStop | null> {
    if (this.reason) return this.reason;
    if (!this.options.enabled()) return "disabled";
    const identity = await proof(this.options, this.controller.signal);
    if (this.reason) return this.reason;
    if (!this.options.enabled()) return "disabled";
    if (!identity) return "unbound";
    if (!sameIdentity(this.identity, identity)) return "changed";
    if ((await realpath(this.identity.path)) !== this.path) return "changed";
    const [named, current] = await Promise.all([lstat(this.path), this.file.stat()]);
    if (
      !fileAllowed(named) ||
      !sameFile(named, current) ||
      !sameFile(current, this.observed) ||
      current.size < this.observed.size
    )
      return "changed";
    if (current.size === this.observed.size && current.mtimeMs !== this.observed.mtimeMs)
      return "changed";
    for (const fence of [...this.fences, ...pendingFences]) {
      const check = Buffer.alloc(fence.bytes.length);
      try {
        const read = await this.file.read(check, 0, check.length, fence.offset);
        if (read.bytesRead !== check.length || !check.equals(fence.bytes)) return "changed";
      } finally {
        check.fill(0);
      }
    }
    if (this.reason) return this.reason;
    // The transcript-file race regressions inject invalidation at this final gate.
    if (!this.options.enabled()) return "disabled";
    this.observed = current;
    return null;
  }
  private availability(): TranscriptStop | null {
    const enabled = this.options.enabled();
    return this.reason ?? (enabled ? null : "disabled");
  }
  private installFences(next: Fence[]): boolean {
    // Cancellation/consent may have changed in the microtask between validation
    // resolving and its caller resuming. Nothing asynchronous follows this gate.
    const unavailable = this.availability();
    if (unavailable) {
      for (const fence of next) fence.bytes.fill(0);
      this.stop(unavailable);
      return false;
    }
    for (const fence of this.fences) fence.bytes.fill(0);
    this.fences = next;
    return true;
  }
  private async captureFences(size: number): Promise<Fence[]> {
    const length = Math.min(FENCE_BYTES, size);
    const next: Fence[] = [];
    try {
      for (const offset of length === size ? [0] : [0, size - length]) {
        const bytes = Buffer.alloc(length);
        next.push({ offset, bytes });
        const read = await this.file.read(bytes, 0, bytes.length, offset);
        if (read.bytesRead !== bytes.length || this.reason) throw new Error("invalidated");
      }
      return next;
    } catch (error) {
      for (const fence of next) fence.bytes.fill(0);
      throw error;
    }
  }
}

/** A slow native identity probe cannot hold an open transcript generation indefinitely. */
async function proof(
  options: TranscriptFileOptions,
  signal?: AbortSignal,
): Promise<TranscriptIdentity | null> {
  if (signal?.aborted || !options.enabled()) return null;
  const controller = new AbortController();
  const stop = () => controller.abort();
  signal?.addEventListener("abort", stop, { once: true });
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    const aborted = new Promise<null>((resolve) => {
      controller.signal.addEventListener("abort", () => resolve(null), { once: true });
      timeout = setTimeout(stop, PROOF_MS);
    });
    const identity = await Promise.race([options.identity(controller.signal), aborted]);
    return identity ? { ...identity } : null;
  } catch {
    return null;
  } finally {
    clearTimeout(timeout);
    signal?.removeEventListener("abort", stop);
    controller.abort();
  }
}
