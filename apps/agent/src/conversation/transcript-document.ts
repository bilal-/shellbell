import { createHash } from "node:crypto";
import type { TranscriptAgent } from "./transcript-file.js";
import { transcriptFormatNotice } from "./transcript-formats.js";
import { TRANSCRIPT_BATCH_LINES } from "./transcript-jsonl.js";
import {
  CodexTranscriptHeader,
  type ConversationEntry,
  TRANSCRIPT_DETAIL_BYTES,
  type TranscriptNode,
  type TranscriptRecord,
  transcriptSessionId,
  transcriptText,
} from "./transcript-record.js";

export const TRANSCRIPT_DOCUMENT_BYTES = 256 * 1024;
export const TRANSCRIPT_DOCUMENT_RECORDS = 2048;
export const TRANSCRIPT_DOCUMENT_ENTRIES = 2000;
/** Folded link IDs remembered; past this, a record naming an older one shows as unlinked. */
const FOLDED_LINKS = 16_384;
export type ConversationHistory = "complete" | "unloaded" | "truncated" | "unlinked";
/** Computer-only branch evidence. Never include this in a phone message. */
export type ConversationBranch =
  | { readonly kind: "codex" }
  /** Whole rows re-read on each change, such as Antigravity steps; no file branch evidence. */
  | { readonly kind: "rows" }
  | {
      readonly kind: "claude";
      readonly nodes: readonly Readonly<{ id: string; start: number }>[];
      /**
       * Off-chain blocks and results of a parallel reply, shown beside the chain. Parallel tool
       * calls move the newest record between these and the chain, which is not a rewind.
       * Never a page join: anchors use `nodes` only.
       */
      readonly parallel?: readonly Readonly<{ id: string; start: number }>[];
    };
export interface ConversationSnapshot {
  readonly state: "ready" | "unbound" | "unsupported" | "closed";
  /** Immutable presentation rows may be reused; branch/revision proofs still need validation. */
  readonly entries: readonly ConversationEntry[];
  readonly history: ConversationHistory;
  /** Relative to the previous produced projection, not the phone's applied baseline. */
  readonly change: "append" | "replace" | "unchanged";
  readonly revision: number;
  readonly branch: Readonly<ConversationBranch> | null;
}
/** A computer-only join to one entry already proven on the selected branch. */
export interface TranscriptPageAnchor {
  readonly agent: TranscriptAgent;
  readonly start: number;
  readonly end: number;
  readonly recordHash: string;
  readonly entryId: string;
  readonly entryHash: string;
  readonly nodeId: string | null;
}
type Stored = { record: TranscriptRecord; bytes: number };
type NodeRecord = TranscriptRecord & { node: NonNullable<TranscriptRecord["node"]> };
type Part = { record: NodeRecord; entry: ConversationEntry; call: string };

function fingerprint(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("base64url");
}

/** Shows no row and carries nothing but its place in the chain. */
function linkOnly(record: TranscriptRecord): record is NodeRecord {
  const node = record.node;
  return (
    !!node &&
    !record.entries.length &&
    node.role === "other" &&
    !node.mainMessage &&
    !node.meta &&
    !node.compact &&
    !node.sourceAssistant &&
    !node.calls.length &&
    !node.results.length
  );
}
function joins(parent: NodeRecord, child: NodeRecord): boolean {
  return (
    child.node.parent === parent.node.id &&
    child.node.scope === parent.node.scope &&
    child.node.session === parent.node.session
  );
}

function order(a: NodeRecord, b: NodeRecord): number {
  const left = a.node.timestamp;
  const right = b.node.timestamp;
  // A total order even when one timestamp is missing: known times first, then file order.
  if (!!left !== !!right) return left ? -1 : 1;
  if (left && right) {
    const normalize = (value: string) =>
      value.replace(
        /(?:\.(\d+))?Z$/,
        (_, fraction: string | undefined) => `.${(fraction ?? "").padEnd(6, "0")}Z`,
      );
    const l = normalize(left);
    const r = normalize(right);
    if (l !== r) return l < r ? -1 : 1;
  }
  return a.start - b.start;
}
function group(records: readonly TranscriptRecord[], id: string): ConversationEntry | null {
  let detail = "";
  let bytes = 0;
  let clipped = false;
  outer: for (const record of records) {
    for (const entry of record.entries) {
      if (bytes >= TRANSCRIPT_DETAIL_BYTES) {
        clipped = true;
        break outer;
      }
      const text = `${entry.kind}: ${entry.text}${entry.detail ? `\n${entry.detail}` : ""}`;
      const remaining = Math.max(0, TRANSCRIPT_DETAIL_BYTES - bytes - (detail ? 1 : 0));
      const part = transcriptText(text, remaining);
      if (detail && remaining) {
        detail += "\n";
        bytes++;
      }
      detail += part.text;
      bytes += Buffer.byteLength(part.text);
      clipped ||= part.truncated || entry.truncated === true;
      if (!remaining) {
        clipped = true;
        break outer;
      }
    }
  }
  if (!detail) return null;
  return Object.freeze({
    id,
    kind: "group",
    text: "Subagent conversation",
    detail,
    collapsed: true,
    ...(clipped && { truncated: true }),
  });
}

/** One proven file generation's bounded projection. Entries alone are safe to send after proof. */
export class TranscriptDocument {
  private readonly expected: string;
  private readonly header: CodexTranscriptHeader | null;
  private records: Stored[] = [];
  private bytes = 0;
  private base = 0;
  private through = 0;
  private revision = 0;
  private evicted = false;
  private invalidated = false;
  private closed = false;
  private previous: string[] | null = null;
  private entryFingerprints = new WeakMap<ConversationEntry, string>();
  private latest: Readonly<ConversationSnapshot> | null = null;
  private latestUnanchored = false;
  private cutKnown: { revision: number; value: boolean } | null = null;
  /** Newest agent version the records name; a version outside the tested range gets a notice. */
  private version: string | null = null;
  private precedingEnd = new Map<string, number>();
  /** Folded-away links, to the ancestor their chain joins, so a later record naming one still links. */
  private folded = new Map<string, string | null | undefined>();
  private unplacedMain = -1;
  private coveredThrough = 0;
  private lookups: {
    revision: number;
    records: Map<string, TranscriptRecord>;
    main: Map<string, NodeRecord>;
    replies: Map<string, number>;
    calls: Map<string, NodeRecord | null>;
  } | null = null;

  constructor(
    private readonly agent: TranscriptAgent,
    session: string,
  ) {
    const expected = transcriptSessionId(session);
    if (!expected || (agent !== "claude" && agent !== "codex"))
      throw new TypeError("Invalid transcript document identity");
    this.expected = expected;
    this.header = agent === "codex" ? new CodexTranscriptHeader(expected) : null;
  }
  get retainedBytes(): number {
    return this.bytes;
  }
  get retainedRecords(): number {
    return this.records.length;
  }
  get cursor(): number {
    return this.through;
  }

  /** After reading the canonical header, a caller can load the newest bounded window. */
  beginWindow(offset: number): void {
    if (this.closed || !Number.isSafeInteger(offset) || offset < 0)
      throw new RangeError("Invalid transcript window");
    this.records = [];
    this.bytes = 0;
    this.base = this.through = offset;
    this.coveredThrough = offset;
    this.unplacedMain = -1;
    this.evicted = false;
    this.previous = null;
    this.latest = null;
    this.entryFingerprints = new WeakMap();
    this.precedingEnd.clear();
    this.folded.clear();
    this.revision++;
  }
  append(records: readonly TranscriptRecord[]): void {
    if (this.closed || records.length > TRANSCRIPT_BATCH_LINES)
      throw new RangeError("Invalid transcript document batch");
    let end = this.through;
    for (const record of records) {
      if (
        !Number.isSafeInteger(record.start) ||
        !Number.isSafeInteger(record.end) ||
        record.start < end ||
        record.end <= record.start
      )
        throw new RangeError("Invalid transcript document order");
      end = record.end;
    }
    for (const value of records) {
      this.header?.observe(value);
      if (value.version) this.version = value.version;
      this.invalidated ||= value.invalidates === true;
      // Session bookkeeping such as modes and titles shows nothing and links nothing; about a
      // third of a current Claude Code transcript. Keeping it would only push out real rows.
      if (!value.node && !value.entries.length) continue;
      let record = value;
      const last = this.records.at(-1);
      if (last && linkOnly(last.record) && linkOnly(record) && joins(last.record, record)) {
        // A chain of rowless records, such as attachments or progress, is kept as its newest
        // record joined to the chain's parent, so a long one can't push out the rows around it.
        // The newest keeps its own ID and offset, so every window reports the same node.
        const ancestor = this.parentOf(last.record.node);
        this.folded.set(last.record.node.id, ancestor);
        if (this.folded.size > FOLDED_LINKS) this.folded.delete(this.folded.keys().next().value!);
        record = Object.freeze({
          ...record,
          node: Object.freeze({ ...record.node!, parent: ancestor }),
        });
        this.records.pop();
        this.bytes -= last.bytes;
      }
      const bytes = Buffer.byteLength(JSON.stringify(record));
      if (bytes > TRANSCRIPT_DOCUMENT_BYTES) {
        this.forgetUnseen(record);
        this.evicted = true;
        continue;
      }
      this.records.push({ record, bytes });
      this.bytes += bytes;
      while (
        this.bytes > TRANSCRIPT_DOCUMENT_BYTES ||
        this.records.length > TRANSCRIPT_DOCUMENT_RECORDS
      ) {
        const removed = this.records.shift()!;
        this.forgetUnseen(removed.record);
        this.bytes -= removed.bytes;
        this.evicted = true;
      }
    }
    this.through = end;
    if (records.length) {
      this.latest = null;
      this.revision++;
    }
  }
  close(): void {
    this.closed = true;
    this.header?.close();
    this.records = [];
    this.bytes = 0;
    this.previous = null;
    this.latest = null;
    this.entryFingerprints = new WeakMap();
    this.precedingEnd.clear();
    this.folded.clear();
    this.lookups = null;
    this.cutKnown = null;
    this.revision++;
  }
  /**
   * Whether any row of the latest projection can start an older page. One pass with the
   * cached lookups, remembered per revision: the follower asks on every poll.
   */
  hasCut(): boolean {
    const snapshot = this.latest;
    if (snapshot?.state !== "ready") return false;
    if (this.cutKnown?.revision === snapshot.revision) return this.cutKnown.value;
    const value = snapshot.entries.some(
      (entry) => !entry.id.startsWith("history:") && this.cut(entry, snapshot.branch) !== null,
    );
    this.cutKnown = { revision: snapshot.revision, value };
    return value;
  }
  /** Synthetic groups and recovered off-chain siblings cannot define a physical page join. */
  /** The partial line at a window's start: what it reads as depends on where the window began. */
  private windowGap(record: TranscriptRecord, history: ConversationHistory): boolean {
    return (
      record.kind === "skipped" &&
      history !== "complete" &&
      record.start === this.base &&
      record.entries[0]?.text === "Earlier content is not loaded"
    );
  }

  anchor(entryId: string): Readonly<TranscriptPageAnchor> | null {
    const snapshot = this.latest;
    if (snapshot?.state !== "ready") return null;
    const entry = snapshot.entries.find((value) => value.id === entryId);
    return entry ? this.cut(entry, snapshot.branch) : null;
  }

  private cut(
    entry: ConversationEntry,
    branch: Readonly<ConversationBranch> | null,
  ): Readonly<TranscriptPageAnchor> | null {
    const entryId = entry.id;
    const index = this.index();
    const record = index.records.get(entryId);
    const stored = record?.entries.find((value) => value.id === entryId);
    if (!record || !stored || (stored !== entry && fingerprint(stored) !== fingerprint(entry)))
      return null;
    // A line that couldn't be read decodes differently in another window, so no page can start
    // from it: an older page would never find it again.
    if (record.kind === "skipped") return null;
    if (
      !this.header &&
      (branch?.kind !== "claude" ||
        !record.node?.mainMessage ||
        record.node.meta ||
        !this.turnStart(record as NodeRecord, entryId) ||
        (this.precedingEnd.get(entryId) ?? Infinity) > record.end ||
        this.unplacedMain >= record.end ||
        !branch.nodes.some((node) => node.id === record.node!.id && node.start === record.start))
    )
      return null;
    return Object.freeze({
      agent: this.header ? "codex" : "claude",
      start: record.start,
      end: record.end,
      recordHash: fingerprint(record),
      entryId,
      entryHash: fingerprint(entry),
      nodeId: record.node?.id ?? null,
    });
  }

  /**
   * A typed prompt, or the first block of an agent reply whose parent provably ends an earlier
   * reply. A busy turn may hold no prompt for megabytes, so its replies must be cuts too.
   */
  private turnStart(record: NodeRecord, entryId: string): boolean {
    const node = record.node;
    if (node.role === "user") return node.results.length === 0;
    if (node.role !== "assistant" || !node.response || record.entries[0]?.id !== entryId)
      return false;
    const { main, replies, calls } = this.index();
    if (replies.get(node.response) !== record.start) return false;
    let parent = this.parentRecord(node, main);
    let start = record.start;
    // Claude Code writes a reply's thinking as its own record ahead of the visible blocks, and
    // can put queued-command attachments and hidden context between turns. None shows a row.
    while (
      parent &&
      parent.start < start &&
      !parent.entries.length &&
      !parent.node.calls.length &&
      !parent.node.results.length &&
      (parent.node.role !== "assistant" || parent.node.response === node.response)
    ) {
      start = parent.start;
      parent = this.parentRecord(parent.node, main);
    }
    if (!parent?.node.mainMessage || parent.start >= start) return false;
    if (parent.node.role === "assistant") return parent.node.response !== node.response;
    if (parent.node.role !== "user") return false;
    // Each result must belong to a retained call from a different reply.
    return parent.node.results.every(({ id }) => {
      const owner = parent.node.sourceAssistant
        ? main.get(parent.node.sourceAssistant)
        : calls.get(id);
      return (
        !!owner?.node.response &&
        owner.node.response !== node.response &&
        owner.node.calls.some((call) => call.id === id)
      );
    });
  }

  /**
   * A node's parent, through any links folded into a later one. Resolved here rather than
   * written into records, so a record's fingerprint is the same in every window.
   */
  private parentOf(node: Readonly<TranscriptNode>): string | null | undefined {
    const parent = node.parent;
    return parent && this.folded.has(parent) ? this.folded.get(parent) : parent;
  }
  private parentRecord(
    node: Readonly<TranscriptNode>,
    records: ReadonlyMap<string, NodeRecord>,
  ): NodeRecord | undefined {
    const parent = this.parentOf(node);
    return parent ? records.get(parent) : undefined;
  }

  /** Lookups for cut checks, rebuilt once per retained-record revision. */
  private index(): {
    readonly records: ReadonlyMap<string, TranscriptRecord>;
    readonly main: ReadonlyMap<string, NodeRecord>;
    /** Start of the first retained visible block of each reply. */
    readonly replies: ReadonlyMap<string, number>;
    readonly calls: ReadonlyMap<string, NodeRecord | null>;
  } {
    if (this.lookups?.revision === this.revision) return this.lookups;
    const records = new Map<string, TranscriptRecord>();
    const main = new Map<string, NodeRecord>();
    const replies = new Map<string, number>();
    const calls = new Map<string, NodeRecord | null>();
    for (const { record } of this.records) {
      for (const entry of record.entries) records.set(entry.id, record);
      if (record.node?.scope !== "main") continue;
      const node = record as NodeRecord;
      main.set(node.node.id, node);
      if (node.node.role !== "assistant") continue;
      if (node.node.response && node.entries.length && !replies.has(node.node.response))
        replies.set(node.node.response, node.start);
      // A repeated call ID is ambiguous, so it can't prove which reply a result ends.
      for (const call of node.node.calls) calls.set(call.id, calls.has(call.id) ? null : node);
    }
    this.lookups = { revision: this.revision, records, main, replies, calls };
    return this.lookups;
  }

  /** Renew a previously issued cut against newly parsed records, including unplaced late tools. */
  permits(anchor: Readonly<TranscriptPageAnchor>): boolean {
    if (this.latest?.state !== "ready" || anchor.agent !== (this.header ? "codex" : "claude"))
      return false;
    if (anchor.agent === "claude" && this.unplacedMain >= anchor.end) return false;
    if (
      this.latest.branch?.kind === "claude" &&
      this.latest.branch.nodes.some(
        (node) => node.id === anchor.nodeId && node.start !== anchor.start,
      )
    )
      return false;
    if (this.records.some(({ record }) => record.start === anchor.start)) {
      const current = this.anchor(anchor.entryId);
      return (
        current !== null &&
        current.recordHash === anchor.recordHash &&
        current.entryHash === anchor.entryHash
      );
    }
    return anchor.end <= (this.records[0]?.record.start ?? this.base);
  }

  snapshot(anchor?: Readonly<TranscriptPageAnchor>): Readonly<ConversationSnapshot> {
    // Idle polls still revalidate the file outside this document. Its immutable
    // projection only changes when records or the window change. Anchored page
    // projections have separate branch/anchor bookkeeping and must not be reused.
    if (!anchor && this.latest && this.latestUnanchored) {
      if (this.latest.change !== "unchanged")
        this.latest = Object.freeze({ ...this.latest, change: "unchanged" });
      return this.latest;
    }
    this.latest = null;
    this.latestUnanchored = !anchor;
    const history: ConversationHistory = this.evicted
      ? "truncated"
      : this.base > 0
        ? "unloaded"
        : "complete";
    if (this.closed) return this.finish("closed", [], history);
    if (this.invalidated) return this.finish("unsupported", [], history);
    if (anchor) {
      const record = this.records.find(({ record }) => record.start === anchor.start)?.record;
      if (
        anchor.agent !== (this.header ? "codex" : "claude") ||
        this.through !== anchor.end ||
        !record ||
        record.end !== anchor.end ||
        fingerprint(record) !== anchor.recordHash ||
        !record.entries.some(
          (entry) => entry.id === anchor.entryId && fingerprint(entry) === anchor.entryHash,
        ) ||
        (record.node?.id ?? null) !== anchor.nodeId
      )
        return this.finish("unbound", [], history);
    }
    if (this.header) {
      if (this.header.status !== "verified")
        return this.finish(
          this.header.status === "unsupported" ? "unsupported" : "unbound",
          [],
          history,
        );
      return this.finish(
        "ready",
        this.records.flatMap(({ record }) =>
          // The cut-off line a window starts inside is a gap only until older pages load.
          this.windowGap(record, history) ? [] : record.entries,
        ),
        history,
        { kind: "codex" },
      );
    }
    return this.claudeSnapshot(history, anchor);
  }

  private claudeSnapshot(
    history: ConversationHistory,
    anchor?: Readonly<TranscriptPageAnchor>,
  ): Readonly<ConversationSnapshot> {
    const nodes = new Map<string, NodeRecord>();
    for (const { record } of this.records)
      if (record.node) nodes.set(record.node.id, record as NodeRecord);
    const main = new Map([...nodes].filter(([, record]) => record.node.scope === "main"));
    const parents = new Set(
      [...main.values()].flatMap((record) => {
        const parent = this.parentOf(record.node);
        return parent ? [parent] : [];
      }),
    );
    const nearest = new Map<string, NodeRecord | null>();
    let leaf: NodeRecord | null = null;
    for (const record of main.values()) {
      if (parents.has(record.node.id)) continue;
      let cursor: NodeRecord | undefined = record;
      const path: string[] = [];
      const seen = new Set<string>();
      let found: NodeRecord | null = null;
      while (cursor && !seen.has(cursor.node.id)) {
        const id = cursor.node.id;
        if (cursor.node.mainMessage) {
          found = cursor;
          break;
        }
        if (nearest.has(id)) {
          found = nearest.get(id)!;
          break;
        }
        seen.add(id);
        path.push(id);
        cursor = this.parentRecord(cursor.node, main);
      }
      for (const id of path) nearest.set(id, found);
      if (found && (!leaf || found.start > leaf.start)) leaf = found;
    }
    if (anchor) leaf = anchor.nodeId ? (main.get(anchor.nodeId) ?? null) : null;
    if (!leaf)
      return this.finish(
        main.size && [...main.values()].some((record) => record.node.mainMessage)
          ? "unsupported"
          : "unbound",
        [],
        history,
      );
    // Inherited ancestors may have older session IDs. The selected current main leaf must match.
    if (!anchor && leaf.node.session !== this.expected) return this.finish("unbound", [], history);
    const chain: NodeRecord[] = [];
    const selected = new Set<string>();
    let cursor: NodeRecord | undefined = leaf;
    let linked = true;
    let rooted = false;
    while (cursor) {
      if (selected.has(cursor.node.id)) return this.finish("unsupported", [], "unlinked");
      selected.add(cursor.node.id);
      chain.push(cursor);
      if (this.parentOf(cursor.node) === null) {
        rooted = true;
        break;
      }
      const parent: NodeRecord | undefined = this.parentRecord(cursor.node, main);
      if (!parent) {
        linked = false;
        break;
      }
      cursor = parent;
    }
    chain.reverse();
    const { entries, after } = this.mainEntries(main, chain, selected);
    const emitted = new Set(entries.map((entry) => entry.id));
    for (const record of main.values())
      if (record.entries.some((entry) => !emitted.has(entry.id)))
        this.unplacedMain = Math.max(this.unplacedMain, record.start);
    const groups = new Map<string, { records: NodeRecord[]; anchor: string }>();
    type SideAnchor = { main: NodeRecord; root: NodeRecord };
    const ancestors = new Map<string, SideAnchor | null>();
    let uncertain = false;
    for (const record of nodes.values()) {
      if (record.node.scope === "main" || !record.entries.length) continue;
      let current: NodeRecord | undefined = record;
      const seen = new Set<string>();
      let anchor: SideAnchor | null = null;
      let root = record;
      while (current && current.node.scope !== "main" && !seen.has(current.node.id)) {
        if (ancestors.has(current.node.id)) {
          anchor = ancestors.get(current.node.id)!;
          break;
        }
        seen.add(current.node.id);
        root = current;
        current = this.parentRecord(current.node, nodes);
      }
      if (current?.node.scope === "main") anchor = { main: current, root };
      for (const id of seen) ancestors.set(id, anchor);
      if (!anchor) {
        uncertain = true;
        continue;
      }
      if (!selected.has(anchor.main.node.id)) continue;
      const scope =
        record.node.scope === "side:unknown"
          ? `side:unknown:${anchor.root.node.id}`
          : record.node.scope;
      const list = groups.get(scope) ?? { records: [], anchor: anchor.main.node.id };
      list.records.push(record);
      groups.set(scope, list);
    }
    const insertions: { at: number; start: number; entry: ConversationEntry }[] = [];
    const groupEnds = new Map<string, number>();
    for (const { records, anchor } of groups.values()) {
      records.sort((a, b) => a.start - b.start);
      const entry = group(records, `side:${records[0]!.start}`);
      if (entry) {
        insertions.push({ at: after.get(anchor) ?? 0, start: records[0]!.start, entry });
        groupEnds.set(entry.id, Math.max(...records.map((record) => record.end)));
      }
    }
    if (uncertain)
      insertions.push({
        at: 0,
        start: 0,
        entry: Object.freeze({
          id: "unlinked-side",
          kind: "unsupported",
          text: "Some subagent activity could not be linked to this conversation.",
        }),
      });
    // Unknown/framing records are notices, never alternative conversation leaves.
    const offsets = new Map(
      this.records.flatMap(({ record }) =>
        record.entries.map((entry) => [entry.id, record.start] as const),
      ),
    );
    for (const { record } of this.records) {
      if (record.node || (record.kind !== "unsupported" && record.kind !== "skipped")) continue;
      if (this.windowGap(record, history)) continue;
      const next = entries.findIndex(
        (entry) => (offsets.get(entry.id) ?? Infinity) >= record.start,
      );
      for (const entry of record.entries)
        insertions.push({ at: next === -1 ? entries.length : next, start: record.start, entry });
    }
    // Insert backwards so each position still refers to the original main projection.
    insertions.sort((a, b) => b.at - a.at || b.start - a.start);
    for (const { at, entry } of insertions) entries.splice(at, 0, entry);
    const onChain = new Set(chain.map((record) => record.node.id));
    return this.finish(
      "ready",
      entries,
      !linked && history === "complete"
        ? "unlinked"
        : // A chain that starts at its root, such as a compaction summary, has nothing before
          // it to load, wherever the window began: a record is written after its parent.
          rooted && history === "unloaded"
          ? "complete"
          : history,
      {
        kind: "claude",
        nodes: Object.freeze(
          chain.map((record) => Object.freeze({ id: record.node.id, start: record.start })),
        ),
        parallel: Object.freeze(
          [...selected]
            .filter((id) => !onChain.has(id))
            .flatMap((id) => {
              const record = main.get(id);
              return record ? [Object.freeze({ id, start: record.start })] : [];
            }),
        ),
      },
      groupEnds,
    );
  }

  /** Recover parallel response blocks/results without following an abandoned response branch. */
  private mainEntries(
    main: Map<string, NodeRecord>,
    chain: NodeRecord[],
    selected: Set<string>,
  ): { entries: ConversationEntry[]; after: Map<string, number> } {
    const anchors = new Map<string, NodeRecord>();
    for (const record of chain) {
      if (record.node.role === "assistant" && record.node.mainMessage && record.node.response)
        anchors.set(record.node.response, record);
    }
    const assistants = new Map<string, NodeRecord[]>();
    const owners = new Map<string, NodeRecord | null>();
    for (const record of main.values()) {
      if (!record.node.mainMessage || record.node.role !== "assistant") continue;
      for (const call of record.node.calls)
        owners.set(call.id, owners.has(call.id) ? null : record);
      if (record.node.response && anchors.has(record.node.response)) {
        const list = assistants.get(record.node.response) ?? [];
        list.push(record);
        assistants.set(record.node.response, list);
      }
    }
    const results = new Map<string, Map<string, Part>>();
    const resolved = new Map<string, string>();
    for (const record of main.values()) {
      if (
        record.node.meta ||
        record.node.role !== "user" ||
        (!selected.has(record.node.id) && !record.node.resultsOnly)
      )
        continue;
      for (const result of record.node.results) {
        let owner = record.node.sourceAssistant ? main.get(record.node.sourceAssistant) : undefined;
        if (record.node.sourceAssistant && !owner?.node.calls.some((call) => call.id === result.id))
          continue;
        if (!owner) {
          const parent = this.parentRecord(record.node, main);
          owner = parent?.node.calls.some((call) => call.id === result.id)
            ? parent
            : (owners.get(result.id) ?? undefined);
        }
        const response = owner?.node.response;
        if (!owner?.node.mainMessage || !response || !anchors.has(response)) continue;
        const entry = record.entries.find((entry) => entry.id === result.entry);
        if (!entry) continue;
        // A key includes the response: a repeated tool ID in another response cannot suppress it.
        resolved.set(entry.id, `${response}/${result.id}`);
        const calls = results.get(response) ?? new Map<string, Part>();
        const previous = calls.get(result.id);
        if (
          !previous ||
          (selected.has(record.node.id) && !selected.has(previous.record.node.id)) ||
          (selected.has(record.node.id) === selected.has(previous.record.node.id) &&
            order(record, previous.record) < 0)
        )
          calls.set(result.id, { record, entry, call: result.id });
        results.set(response, calls);
      }
    }
    const chosen = new Set<string>();
    for (const calls of results.values())
      for (const part of calls.values()) chosen.add(part.entry.id);
    const output: ConversationEntry[] = [];
    const emitted = new Set<string>();
    const add = (entry: ConversationEntry) => {
      if (resolved.has(entry.id) && !chosen.has(entry.id)) return;
      if (!emitted.has(entry.id)) {
        emitted.add(entry.id);
        output.push(entry);
      }
    };
    // Keep the active chain's order. Recover siblings/results after its last assistant block
    // for that response, so intervening on-chain user content is never moved to the beginning.
    const onChain = new Set(selected);
    const after = new Map<string, number>();
    for (const record of chain) {
      if (!record.node.meta) for (const entry of record.entries) add(entry);
      after.set(record.node.id, output.length);
      const response = record.node.response;
      if (!response || anchors.get(response) !== record) continue;
      for (const member of (assistants.get(response) ?? []).sort(order)) {
        if (onChain.has(member.node.id)) continue;
        selected.add(member.node.id);
        for (const entry of member.entries) add(entry);
        after.set(member.node.id, output.length);
      }
      for (const part of [...(results.get(response)?.values() ?? [])].sort((a, b) =>
        order(a.record, b.record),
      )) {
        if (onChain.has(part.record.node.id)) continue;
        selected.add(part.record.node.id);
        add(part.entry);
        after.set(part.record.node.id, output.length);
      }
    }
    return { entries: output, after };
  }

  private finish(
    state: ConversationSnapshot["state"],
    source: ConversationEntry[],
    history: ConversationHistory,
    branch: ConversationBranch | null = null,
    groupEnds?: ReadonlyMap<string, number>,
  ): Readonly<ConversationSnapshot> {
    let entries: ConversationEntry[] = [];
    let bytes = 2;
    if (state === "ready") {
      for (let i = source.length - 1; i >= 0; i--) {
        const entry = source[i]!;
        const size = Buffer.byteLength(JSON.stringify(entry)) + 1;
        if (
          entries.length >= TRANSCRIPT_DOCUMENT_ENTRIES - 1 ||
          bytes + size > TRANSCRIPT_DOCUMENT_BYTES - 512
        ) {
          history = "truncated";
          break;
        }
        entries.push(entry);
        bytes += size;
      }
      entries.reverse();
    }
    const cuts = new Map(
      this.records.flatMap(({ record }) =>
        record.node?.mainMessage &&
        !record.node.meta &&
        record.entries[0] &&
        this.turnStart(record as NodeRecord, record.entries[0].id)
          ? record.entries.map((entry) => [entry.id, record.end] as const)
          : [],
      ),
    );
    const ends = new Map(
      this.records.flatMap(({ record }) =>
        record.entries.map((entry) => [entry.id, record.end] as const),
      ),
    );
    for (const [id, end] of groupEnds ?? []) ends.set(id, end);
    const retained = new Set(entries.map((entry) => entry.id));
    this.precedingEnd.clear();
    let through = 0;
    for (const entry of source) {
      if (entry.id !== "unlinked-side" && !entry.id.startsWith("history:"))
        through = Math.max(through, ends.get(entry.id) ?? Infinity);
      if (retained.has(entry.id)) this.precedingEnd.set(entry.id, through);
      const cut = cuts.get(entry.id);
      if (cut !== undefined && through > cut) this.unplacedMain = Math.max(this.unplacedMain, cut);
    }
    if (
      state === "ready" &&
      this.latestUnanchored &&
      (history === "unloaded" || history === "truncated")
    ) {
      // Older rows before the first cut could never be paged past. Start at that cut so the
      // phone can load everything before it as older pages instead. Pages trim themselves.
      const first = entries.findIndex(
        (entry) => entry.id !== "unlinked-side" && this.cut(entry, branch) !== null,
      );
      if (first > 0)
        entries = entries.filter((entry, index) => index >= first || entry.id === "unlinked-side");
    }
    if (state === "ready") {
      const notice: Partial<Record<ConversationHistory, string>> = {
        unloaded: "Earlier conversation is not loaded.",
        truncated: "Earlier conversation omitted to save memory.",
        unlinked: "Some earlier conversation entries could not be linked.",
      };
      if (notice[history])
        entries.unshift(
          Object.freeze({ id: `history:${history}`, kind: "status", text: notice[history]! }),
        );
      const format =
        this.latestUnanchored && this.version
          ? transcriptFormatNotice(this.agent, this.version)
          : null;
      if (format) entries.push(Object.freeze({ id: "format", kind: "status", text: format }));
    }
    // Parsed entries are immutable; an append usually adds only a few of them.
    // Weak keys let evicted entries disappear with the bounded record window.
    const fingerprints = entries.map((entry) => {
      let value = this.entryFingerprints.get(entry);
      if (value === undefined) {
        value = fingerprint(entry);
        this.entryFingerprints.set(entry, value);
      }
      return value;
    });
    const prefix =
      this.previous !== null &&
      this.previous.length <= fingerprints.length &&
      this.previous.every((value, index) => value === fingerprints[index]);
    const change = prefix
      ? this.previous!.length === fingerprints.length
        ? "unchanged"
        : "append"
      : "replace";
    this.previous = fingerprints;
    this.coveredThrough = this.through;
    this.latest = Object.freeze({
      state,
      entries: Object.freeze(entries),
      history,
      change,
      revision: this.revision,
      branch: branch && state === "ready" ? Object.freeze(branch) : null,
    });
    return this.latest;
  }

  private forgetUnseen(record: TranscriptRecord): void {
    if (
      record.end > this.coveredThrough &&
      record.node?.scope === "main" &&
      (record.node.results.length || record.node.role === "assistant")
    )
      this.unplacedMain = Math.max(this.unplacedMain, record.start);
  }
}
