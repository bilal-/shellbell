import { CONVERSATION_LIMITS } from "@shellbell/protocol";
import {
  type ConversationBranch,
  type ConversationHistory,
  TranscriptDocument,
  type TranscriptPageAnchor,
} from "./transcript-document.js";
import { TRANSCRIPT_READ_BYTES, type TranscriptRead } from "./transcript-file.js";
import { TRANSCRIPT_BATCH_LINES, TranscriptJsonl } from "./transcript-jsonl.js";
import {
  type ConversationEntry,
  decodeTranscriptRecord,
  type TranscriptRecord,
  transcriptOutline,
} from "./transcript-record.js";

const HISTORY_WINDOW_BYTES = 256 * 1024;
/**
 * A narrower window's records are reused up to this many and this much text; past either, they
 * are dropped as they are read and the wider window rereads.
 */
const CARRY_RECORDS = 2048;
const CARRY_CHARS = 4 * 1024 * 1024;
/**
 * How far back a window may widen past huge records such as screenshots, to find a message
 * or a row older pages can start from. Oversized lines decode small, so this costs reading
 * time, not document memory.
 */
export const TRANSCRIPT_REACH_BYTES = 8 * 1024 * 1024;
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
  private document!: TranscriptDocument;
  private decoder!: TranscriptJsonl;
  private readonly anchor: Readonly<TranscriptPageAnchor>;
  private raw: Uint8Array | null = null;
  private consumed = 0;
  private closed = false;
  private reach = HISTORY_WINDOW_BYTES;
  /** Where reading stops: the anchor, or the first record already read by a narrower window. */
  private target = 0;
  private windowStart = 0;
  /** Records this window has read, in order, so a wider window needn't read them again. */
  private decoded: TranscriptRecord[] | null = [];
  private decodedChars = 0;
  /** Records from the narrower window, appended once reading reaches them. */
  private carry: TranscriptRecord[] = [];

  constructor(
    anchor: Readonly<TranscriptPageAnchor>,
    private readonly session: string,
    private readonly header: TranscriptRecord | null,
  ) {
    this.anchor = Object.freeze({ ...anchor });
    this.target = this.anchor.end;
    this.begin();
  }

  private begin(): void {
    this.document = new TranscriptDocument(this.anchor.agent, this.session);
    if (this.anchor.agent === "codex" && this.header) this.document.append([this.header]);
    const start = Math.max(0, this.anchor.end - this.reach);
    this.windowStart = start;
    this.decoded = [];
    this.decodedChars = 0;
    this.document.beginWindow(start);
    this.decoder = new TranscriptJsonl(start, start > 0, transcriptOutline(this.anchor.agent));
  }

  /** Keeps records for a wider window within its limits, or stops keeping them at all. */
  private keep(records: readonly TranscriptRecord[]): void {
    if (!this.decoded) return;
    for (const record of records)
      for (const entry of record.entries)
        this.decodedChars += entry.text.length + (entry.detail?.length ?? 0);
    if (this.decoded.length + records.length > CARRY_RECORDS || this.decodedChars > CARRY_CHARS) {
      this.decoded = null;
      return;
    }
    this.decoded.push(...records);
  }

  /** Once reading reaches the narrower window's records, add them after what was just read. */
  private joinCarry(): void {
    if (this.raw || this.decoder.offset < this.target || !this.carry.length) return;
    const carry = this.carry;
    this.carry = [];
    for (let i = 0; i < carry.length; i += TRANSCRIPT_BATCH_LINES)
      this.document.append(carry.slice(i, i + TRANSCRIPT_BATCH_LINES));
    this.keep(carry);
    this.target = this.anchor.end;
    // Later reads continue from the anchor's end, past the records just added.
    this.decoder.close();
    this.decoder = new TranscriptJsonl(this.target, false, transcriptOutline(this.anchor.agent));
  }

  /** Large records can leave a window without the anchor's chain or a row to continue from. */
  private widen(): TranscriptHistoryResult | null {
    if (this.reach >= TRANSCRIPT_REACH_BYTES || this.anchor.end <= this.reach) return null;
    this.reach = Math.min(TRANSCRIPT_REACH_BYTES, this.reach * 2);
    // Keep what this window read, without its first record if that was only the tail of a line
    // that began before the window. The wider window reads up to the first kept record.
    const prior = this.decoded?.filter(
      (record) => !(record.start === this.windowStart && this.windowStart > 0),
    );
    if (prior?.length) {
      this.carry = prior;
      this.target = prior[0]!.start;
    } else {
      this.carry = [];
      this.target = this.anchor.end;
    }
    this.raw?.fill(0);
    this.raw = null;
    this.consumed = 0;
    this.decoder.close();
    this.document.close();
    this.begin();
    return { status: "reading" };
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
      this.joinCarry();
      const left = this.target - this.decoder.offset;
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
      const records = framed.lines.map((line) => decodeTranscriptRecord(this.anchor.agent, line));
      this.document.append(records);
      this.keep(records);
      if (this.consumed === this.raw.byteLength) {
        this.raw.fill(0);
        this.raw = null;
        this.consumed = 0;
      }
    }
    this.joinCarry();
    return this.raw || this.decoder.offset < this.target ? { status: "reading" } : this.finish();
  }

  private finish(): TranscriptHistoryResult {
    const snapshot = this.document.snapshot(this.anchor);
    const at = snapshot.entries.findIndex((entry) => entry.id === this.anchor.entryId);
    if (snapshot.state !== "ready" || at < 0) {
      const wider = this.widen();
      if (wider) return wider;
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
    // Start the page at its oldest cut, so the next page can continue from there. Rows before
    // that cut arrive with the next page. A page with no cut stays whole and ends paging.
    const cut = entries.findIndex((item) => item.anchor);
    if (cut > 0) entries.splice(0, cut);
    const mainHistory =
      snapshot.history === "complete" && entries.length < prefix.length
        ? "unloaded"
        : snapshot.history;
    if (cut < 0 && mainHistory !== "complete") {
      const wider = this.widen();
      if (wider) return wider;
    }
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
