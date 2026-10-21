import { MAX_PAIRINGS } from "@shellbell/protocol";
import { type ConversationSnapshot, TranscriptDocument } from "./transcript-document.js";
import {
  TRANSCRIPT_READ_BYTES,
  TranscriptFile,
  type TranscriptFileOptions,
  type TranscriptStop,
} from "./transcript-file.js";
import { TRANSCRIPT_LINE_BYTES, TranscriptJsonl } from "./transcript-jsonl.js";
import {
  CodexTranscriptHeader,
  decodeTranscriptRecord,
  transcriptSessionId,
} from "./transcript-record.js";

export const TRANSCRIPT_WINDOW_BYTES = 256 * 1024;
export const TRANSCRIPT_FOLLOW_MS = 10_000;
const BATCHES_PER_POLL = 4;
export type TranscriptFollowStop = TranscriptStop | "timeout" | "unsupported";
type Stopped = { readonly status: "stopped"; readonly reason: TranscriptFollowStop };
type Busy = { readonly status: "busy" };
export type TranscriptPoll =
  | Stopped
  | Busy
  | { readonly status: "catching-up"; readonly discontinuity: number }
  | {
      readonly status: "snapshot";
      readonly snapshot: Readonly<ConversationSnapshot>;
      readonly discontinuity: number;
      /** No unread bytes at the last check; an unfinished final JSONL record may still be held. */
      readonly caughtUp: boolean;
    };
export type TranscriptConfirmation =
  | Stopped
  | Busy
  | { readonly status: "changed" }
  | { readonly status: "confirmed"; readonly caughtUp: boolean };
export interface TranscriptFollower {
  /** One read window or bounded portion of an already read window; never an unbounded tail loop. */
  poll(): Promise<TranscriptPoll>;
  /** Renew ownership and sampled append-only consistency checks; reports later unread bytes. */
  confirm(revision: number): Promise<TranscriptConfirmation>;
  close(): void;
  /** Closing is immediate logically; this waits for actual owned work and descriptor cleanup. */
  readonly drained: Promise<void>;
}
interface Admission {
  begin(): boolean;
  end(): void;
  release(): void;
}

/** Share one pool and one locator across all runtime views and retries. No queued work promises. */
export class TranscriptFollowers {
  private readonly sources = new Map<object, Follower | null>();
  private working: Follower | null = null;
  private closed = false;

  get active(): number {
    return this.sources.size;
  }
  get busy(): boolean {
    return this.working !== null;
  }

  create(options: TranscriptFileOptions): TranscriptFollower | null {
    if (this.closed || this.sources.size >= MAX_PAIRINGS) return null;
    const token = {};
    this.sources.set(token, null);
    try {
      const follower = new Follower(options, {
        begin: () => {
          if (this.closed || this.working) return false;
          this.working = follower;
          return true;
        },
        end: () => {
          if (this.working === follower) this.working = null;
        },
        release: () => {
          this.sources.delete(token);
        },
      });
      if (this.closed) {
        follower.close();
        return null;
      }
      this.sources.set(token, follower);
      follower.activate();
      return follower;
    } catch {
      this.sources.delete(token);
      return null;
    }
  }

  close(): void {
    this.closed = true;
    for (const follower of [...this.sources.values()]) follower?.close();
  }
}

class Follower implements TranscriptFollower {
  private readonly controller = new AbortController();
  private readonly options: TranscriptFileOptions;
  private readonly onAbort = () => this.close();
  private reason: TranscriptFollowStop | null = null;
  private file: TranscriptFile | null = null;
  private document: TranscriptDocument | null = null;
  private decoder: TranscriptJsonl | null = null;
  private header: CodexTranscriptHeader | null = null;
  private raw: Uint8Array | null = null;
  private consumed = 0;
  private pending = false;
  private fileClosed = true;
  private released = false;
  private discontinuity = 0;
  private currentRevision: number | null = null;
  /** Fixed read extent for the next projection. Appends must not keep moving this target. */
  private target: number | null = null;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private finishStopped!: (result: Stopped) => void;
  private readonly stopped = new Promise<Stopped>((resolve) => {
    this.finishStopped = resolve;
  });
  private finishDrained!: () => void;
  readonly drained = new Promise<void>((resolve) => {
    this.finishDrained = resolve;
  });

  constructor(
    options: TranscriptFileOptions,
    private readonly admission: Admission,
  ) {
    const copy = (roots: readonly string[]) => {
      const count = roots.length;
      if (!Array.isArray(roots) || !Number.isSafeInteger(count) || count < 0 || count > 8)
        throw new TypeError("Invalid transcript roots");
      const owned: string[] = [];
      for (let i = 0; i < count; i++) owned.push(roots[i]!);
      return owned;
    };
    this.options = {
      enabled: options.enabled.bind(options),
      identity: options.identity.bind(options),
      signal: options.signal,
      roots: { claude: copy(options.roots.claude), codex: copy(options.roots.codex) },
    };
  }
  activate(): void {
    this.options.signal?.addEventListener("abort", this.onAbort, { once: true });
    this.available();
  }
  close(): void {
    this.stop("cancelled");
  }

  poll(): Promise<TranscriptPoll> {
    return this.run(() => this.advance());
  }
  confirm(revision: number): Promise<TranscriptConfirmation> {
    return this.run(async () => {
      if (
        !Number.isSafeInteger(revision) ||
        revision < 0 ||
        this.currentRevision !== revision ||
        !this.file ||
        !this.decoder
      )
        return { status: "changed" };
      const result = await this.file.verify();
      if (!this.available()) return this.stopResult();
      if (result.status === "stopped") return this.stop(result.reason);
      if (result.status === "busy") return result;
      if (
        this.raw ||
        this.header ||
        result.size < this.decoder.offset ||
        this.currentRevision !== revision
      ) {
        this.currentRevision = null;
        return { status: "changed" };
      }
      return { status: "confirmed", caughtUp: result.size === this.decoder.offset };
    });
  }

  private async run<T extends TranscriptPoll | TranscriptConfirmation>(
    work: () => Promise<T>,
  ): Promise<T | Stopped | Busy> {
    if (!this.available()) return this.stopResult();
    if (this.pending || !this.admission.begin()) return { status: "busy" };
    this.pending = true;
    this.timer = setTimeout(() => this.stop("timeout"), TRANSCRIPT_FOLLOW_MS);
    const operation = Promise.resolve().then(async () => {
      try {
        if (!this.available()) return this.stopResult();
        return await work();
      } catch {
        // Native/FS/JSON failures may contain paths or transcript text. Keep only a fixed reason.
        return this.stop("unreadable");
      } finally {
        clearTimeout(this.timer);
        this.timer = undefined;
        this.pending = false;
        this.admission.end();
        this.finish();
      }
    });
    const result = await Promise.race([operation, this.stopped]);
    return this.available() ? result : this.stopResult();
  }

  private async advance(): Promise<TranscriptPoll> {
    if (!this.file) {
      const opened = await TranscriptFile.open({ ...this.options, signal: this.controller.signal });
      if (opened.status === "stopped") return this.stop(opened.reason);
      this.file = opened.file;
      this.fileClosed = false;
      void opened.file.closed.then(() => {
        this.fileClosed = true;
        this.finish();
      });
      if (!this.available()) {
        opened.file.close();
        return this.stopResult();
      }
      if (!transcriptSessionId(opened.file.identity.session)) return this.stop("unbound");
      this.document = new TranscriptDocument(
        opened.file.identity.agent,
        opened.file.identity.session,
      );
      if (opened.file.identity.agent === "codex") {
        this.header = new CodexTranscriptHeader(opened.file.identity.session);
        this.decoder = new TranscriptJsonl();
      } else this.window(Math.max(0, opened.file.size - TRANSCRIPT_WINDOW_BYTES));
    }
    const file = this.file;
    if (this.raw) {
      // A previous poll's remaining bytes still need renewed ownership proof before use.
      const proof = await file.verify();
      if (!this.available()) return this.stopResult();
      if (proof.status === "stopped") return this.stop(proof.reason);
      if (proof.status === "busy") return proof;
    } else {
      if (this.target === this.decoder!.offset) this.target = null;
      const left =
        this.target === null ? TRANSCRIPT_READ_BYTES : this.target - this.decoder!.offset;
      const read = await file.read(
        this.decoder!.offset,
        Math.max(1, Math.min(TRANSCRIPT_READ_BYTES, left)),
      );
      if (!this.available()) {
        if (read.status === "data") read.bytes.fill(0);
        return this.stopResult();
      }
      if (read.status === "stopped") return this.stop(read.reason);
      if (read.status === "busy") return read;
      this.raw = read.bytes;
      this.consumed = 0;
      this.target ??= read.size;
    }
    for (let batch = 0; batch < BATCHES_PER_POLL && this.raw; batch++) {
      const chunk = this.raw.subarray(this.consumed);
      const framed = this.decoder!.push(chunk);
      chunk.fill(0, 0, framed.consumed);
      this.consumed += framed.consumed;
      if (this.consumed === this.raw.byteLength) this.clearRaw();
      if (this.header && framed.lines.length) {
        const first = decodeTranscriptRecord(file.identity.agent, framed.lines[0]!);
        this.header.observe(first);
        if (this.header.status !== "verified")
          return this.stop(this.header.status === "mismatch" ? "unbound" : "unsupported");
        this.header = null;
        this.document!.append([first]);
        if (file.size > TRANSCRIPT_WINDOW_BYTES) {
          this.window(file.size - TRANSCRIPT_WINDOW_BYTES);
          return this.catchingUp();
        }
        this.document!.append(
          framed.lines.slice(1).map((line) => decodeTranscriptRecord(file.identity.agent, line)),
        );
      } else if (!this.header && framed.lines.length) {
        this.document!.append(
          framed.lines.map((line) => decodeTranscriptRecord(file.identity.agent, line)),
        );
      }
      if (framed.lines.length) this.currentRevision = null;
      if (this.header && this.decoder!.offset > TRANSCRIPT_LINE_BYTES + 1)
        return this.stop("unsupported");
    }
    if (!this.available()) return this.stopResult();
    if (!this.header && this.lagged()) return this.catchingUp();
    if (this.header || this.raw || this.decoder!.offset !== this.target) return this.catchingUp();
    const snapshot = this.document!.snapshot();
    if (snapshot.state === "unsupported") return this.stop("unsupported");
    this.currentRevision = snapshot.state === "ready" ? snapshot.revision : null;
    this.target = null;
    return {
      status: "snapshot",
      snapshot,
      discontinuity: this.discontinuity,
      caughtUp: this.decoder!.offset === file.size,
    };
  }

  private lagged(): boolean {
    if (this.file!.size - this.decoder!.offset <= TRANSCRIPT_WINDOW_BYTES) return false;
    if (this.discontinuity === Number.MAX_SAFE_INTEGER) {
      this.stop("unsafe");
      return true;
    }
    this.discontinuity++;
    // A smaller recovery window leaves room for continuing appends while catching up.
    this.window(Math.max(0, this.file!.size - TRANSCRIPT_READ_BYTES));
    return true;
  }
  private window(offset: number): void {
    this.clearRaw();
    this.decoder?.close();
    this.decoder = new TranscriptJsonl(offset, offset > 0);
    this.document!.beginWindow(offset);
    this.target = this.file!.size;
    this.currentRevision = null;
  }
  private clearRaw(): void {
    this.raw?.fill(0);
    this.raw = null;
    this.consumed = 0;
  }
  private catchingUp(): TranscriptPoll {
    return this.reason
      ? this.stopResult()
      : { status: "catching-up", discontinuity: this.discontinuity };
  }
  private available(): boolean {
    if (this.reason) return false;
    try {
      if (this.options.signal?.aborted) this.stop("cancelled");
      else {
        const enabled = this.options.enabled();
        if (!enabled) this.stop("disabled");
      }
    } catch {
      this.stop("unreadable");
    }
    return this.reason === null;
  }
  private stopResult(): Stopped {
    return { status: "stopped", reason: this.reason! };
  }
  private stop(reason: TranscriptFollowStop): Stopped {
    if (!this.reason) {
      this.reason = reason;
      clearTimeout(this.timer);
      this.controller.abort();
      this.options.signal?.removeEventListener("abort", this.onAbort);
      this.file?.close();
      this.document?.close();
      this.decoder?.close();
      this.header?.close();
      this.clearRaw();
      this.currentRevision = null;
      this.finishStopped(this.stopResult());
      this.finish();
    }
    return this.stopResult();
  }
  private finish(): void {
    if (this.reason && !this.pending && this.fileClosed && !this.released) {
      this.released = true;
      this.file = null;
      this.document = null;
      this.decoder = null;
      this.header = null;
      this.admission.release();
      this.finishDrained();
    }
  }
}
