import { CONVERSATION_LIMITS } from "@shellbell/protocol";
import {
  type ConversationBranch,
  type ConversationHistory,
  TranscriptDocument,
  type TranscriptPageAnchor,
} from "./transcript-document.js";
import { TRANSCRIPT_READ_BYTES, type TranscriptRead } from "./transcript-file.js";
import { TranscriptJsonl } from "./transcript-jsonl.js";
import {
  type ConversationEntry,
  decodeTranscriptRecord,
  type TranscriptRecord,
} from "./transcript-record.js";

const HISTORY_WINDOW_BYTES = 256 * 1024;
const PAGE_BYTES = CONVERSATION_LIMITS.batchBytes - 2048;
export interface TranscriptHistoryEntry {
  readonly entry: Readonly<ConversationEntry>;
  readonly anchor: Readonly<TranscriptPageAnchor> | null;
}
export type TranscriptHistoryResult =
  | { readonly status: "reading" | "unavailable" | "busy" }
  | Extract<TranscriptRead, { status: "stopped" }>
  | {
      readonly status: "page";
      readonly entries: readonly Readonly<TranscriptHistoryEntry>[];
      readonly history: ConversationHistory;
      readonly more?: boolean;
      readonly branch?: Readonly<ConversationBranch> | null;
    };

/** One backwards window on the follower's existing descriptor and admission.
 * No filesystem access, path, independently opened reader, or unbounded scan lives here. */
export class TranscriptHistory {
  private readonly document: TranscriptDocument;
  private readonly decoder: TranscriptJsonl;
  private readonly anchor: Readonly<TranscriptPageAnchor>;
  private raw: Uint8Array | null = null;
  private consumed = 0;
  private closed = false;

  constructor(
    anchor: Readonly<TranscriptPageAnchor>,
    session: string,
    header: TranscriptRecord | null,
  ) {
    this.anchor = Object.freeze({ ...anchor });
    this.document = new TranscriptDocument(anchor.agent, session);
    if (anchor.agent === "codex" && header) this.document.append([header]);
    const start = Math.max(0, anchor.end - HISTORY_WINDOW_BYTES);
    this.document.beginWindow(start);
    this.decoder = new TranscriptJsonl(start, start > 0);
  }

  close(): void {
    this.closed = true;
    this.raw?.fill(0);
    this.raw = null;
    this.document.close();
    this.decoder.close();
  }

  /** One bounded read or at most four decoder batches; the caller owns proof and admission. */
  async next(
    read: (offset: number, length: number) => Promise<TranscriptRead>,
  ): Promise<TranscriptHistoryResult> {
    if (this.closed) return { status: "unavailable" };
    if (!this.raw) {
      const left = this.anchor.end - this.decoder.offset;
      if (left <= 0) return this.finish();
      const result = await read(this.decoder.offset, Math.min(left, TRANSCRIPT_READ_BYTES));
      if (this.closed) {
        if (result.status === "data") result.bytes.fill(0);
        return { status: "unavailable" };
      }
      if (result.status !== "data") return result;
      if (
        !result.bytes.byteLength ||
        result.offset !== this.decoder.offset ||
        result.bytes.byteLength > left
      ) {
        result.bytes.fill(0);
        this.close();
        return { status: "unavailable" };
      }
      this.raw = result.bytes;
      this.consumed = 0;
    }
    for (let batch = 0; batch < 4 && this.raw; batch++) {
      const bytes = this.raw.subarray(this.consumed);
      const framed = this.decoder.push(bytes);
      bytes.fill(0, 0, framed.consumed);
      this.consumed += framed.consumed;
      this.document.append(
        framed.lines.map((line) => decodeTranscriptRecord(this.anchor.agent, line)),
      );
      if (this.consumed === this.raw.byteLength) {
        this.raw.fill(0);
        this.raw = null;
        this.consumed = 0;
      }
    }
    return this.raw || this.decoder.offset < this.anchor.end
      ? { status: "reading" }
      : this.finish();
  }

  private finish(): TranscriptHistoryResult {
    const snapshot = this.document.snapshot(this.anchor);
    const at = snapshot.entries.findIndex((entry) => entry.id === this.anchor.entryId);
    if (snapshot.state !== "ready" || at < 0) {
      this.close();
      return { status: "unavailable" };
    }
    const prefix = snapshot.entries
      .slice(0, at)
      .filter((entry) => !entry.id.startsWith("history:") && entry.id !== "unlinked-side");
    const entries: Readonly<TranscriptHistoryEntry>[] = [];
    let bytes = 0;
    for (let i = prefix.length - 1; i >= 0; i--) {
      const entry = prefix[i]!;
      const size = Buffer.byteLength(JSON.stringify(entry));
      if (entries.length >= CONVERSATION_LIMITS.entriesPerBatch || bytes + size > PAGE_BYTES) break;
      entries.push(Object.freeze({ entry, anchor: this.document.anchor(entry.id) }));
      bytes += size;
    }
    entries.reverse();
    const mainHistory =
      snapshot.history === "complete" && entries.length < prefix.length
        ? "unloaded"
        : snapshot.history;
    const history = snapshot.entries.some((entry) => entry.id === "unlinked-side")
      ? "unlinked"
      : mainHistory;
    this.close();
    if (!entries.length && (prefix.length || history !== "complete"))
      return { status: "unavailable" };
    return Object.freeze({
      status: "page",
      entries: Object.freeze(entries),
      history,
      more: mainHistory !== "complete",
      branch: snapshot.branch,
    });
  }
}
