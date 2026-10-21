import { createHash } from "node:crypto";
import type { TranscriptAgent } from "./transcript-file.js";
import { TRANSCRIPT_BATCH_LINES } from "./transcript-jsonl.js";
import {
  CodexTranscriptHeader,
  type ConversationEntry,
  TRANSCRIPT_DETAIL_BYTES,
  type TranscriptRecord,
  transcriptSessionId,
  transcriptText,
} from "./transcript-record.js";

export const TRANSCRIPT_DOCUMENT_BYTES = 256 * 1024;
export const TRANSCRIPT_DOCUMENT_RECORDS = 2048;
export const TRANSCRIPT_DOCUMENT_ENTRIES = 2000;
export type ConversationHistory = "complete" | "unloaded" | "truncated" | "unlinked";
/** Computer-only branch evidence. Never include this in a phone message. */
export type ConversationBranch =
  | { readonly kind: "codex" }
  | { readonly kind: "claude"; readonly nodes: readonly Readonly<{ id: string; start: number }>[] };
export interface ConversationSnapshot {
  readonly state: "ready" | "unbound" | "unsupported" | "closed";
  readonly entries: readonly ConversationEntry[];
  readonly history: ConversationHistory;
  /** Relative to the previous produced projection, not the phone's applied baseline. */
  readonly change: "append" | "replace" | "unchanged";
  readonly revision: number;
  readonly branch: Readonly<ConversationBranch> | null;
}
type Stored = { record: TranscriptRecord; bytes: number };
type NodeRecord = TranscriptRecord & { node: NonNullable<TranscriptRecord["node"]> };
type Part = { record: NodeRecord; entry: ConversationEntry; call: string };

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

  constructor(agent: TranscriptAgent, session: string) {
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
    this.evicted = false;
    this.previous = null;
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
    for (const record of records) {
      this.header?.observe(record);
      this.invalidated ||= record.invalidates === true;
      const bytes = Buffer.byteLength(JSON.stringify(record));
      if (bytes > TRANSCRIPT_DOCUMENT_BYTES) {
        this.evicted = true;
        continue;
      }
      this.records.push({ record, bytes });
      this.bytes += bytes;
      while (
        this.bytes > TRANSCRIPT_DOCUMENT_BYTES ||
        this.records.length > TRANSCRIPT_DOCUMENT_RECORDS
      ) {
        this.bytes -= this.records.shift()!.bytes;
        this.evicted = true;
      }
    }
    this.through = end;
    if (records.length) this.revision++;
  }
  close(): void {
    this.closed = true;
    this.header?.close();
    this.records = [];
    this.bytes = 0;
    this.previous = null;
    this.revision++;
  }
  snapshot(): Readonly<ConversationSnapshot> {
    const history: ConversationHistory = this.evicted
      ? "truncated"
      : this.base > 0
        ? "unloaded"
        : "complete";
    if (this.closed) return this.finish("closed", [], history);
    if (this.invalidated) return this.finish("unsupported", [], history);
    if (this.header) {
      if (this.header.status !== "verified")
        return this.finish(
          this.header.status === "unsupported" ? "unsupported" : "unbound",
          [],
          history,
        );
      return this.finish(
        "ready",
        this.records.flatMap(({ record }) => record.entries),
        history,
        { kind: "codex" },
      );
    }
    return this.claudeSnapshot(history);
  }

  private claudeSnapshot(history: ConversationHistory): Readonly<ConversationSnapshot> {
    const nodes = new Map<string, NodeRecord>();
    for (const { record } of this.records)
      if (record.node) nodes.set(record.node.id, record as NodeRecord);
    const main = new Map([...nodes].filter(([, record]) => record.node.scope === "main"));
    const parents = new Set(
      [...main.values()].flatMap((record) => (record.node.parent ? [record.node.parent] : [])),
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
        cursor = cursor.node.parent ? main.get(cursor.node.parent) : undefined;
      }
      for (const id of path) nearest.set(id, found);
      if (found && (!leaf || found.start > leaf.start)) leaf = found;
    }
    if (!leaf)
      return this.finish(
        main.size && [...main.values()].some((record) => record.node.mainMessage)
          ? "unsupported"
          : "unbound",
        [],
        history,
      );
    // Inherited ancestors may have older session IDs. The selected current main leaf must match.
    if (leaf.node.session !== this.expected) return this.finish("unbound", [], history);
    const chain: NodeRecord[] = [];
    const selected = new Set<string>();
    let cursor: NodeRecord | undefined = leaf;
    let linked = true;
    while (cursor) {
      if (selected.has(cursor.node.id)) return this.finish("unsupported", [], "unlinked");
      selected.add(cursor.node.id);
      chain.push(cursor);
      if (cursor.node.parent === null) break;
      const parent: NodeRecord | undefined = cursor.node.parent
        ? main.get(cursor.node.parent)
        : undefined;
      if (!parent) {
        linked = false;
        break;
      }
      cursor = parent;
    }
    chain.reverse();
    const { entries, after } = this.mainEntries(main, chain, selected);
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
        current = current.node.parent ? nodes.get(current.node.parent) : undefined;
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
    for (const { records, anchor } of groups.values()) {
      records.sort((a, b) => a.start - b.start);
      const entry = group(records, `side:${records[0]!.start}`);
      if (entry) insertions.push({ at: after.get(anchor) ?? 0, start: records[0]!.start, entry });
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
      if (
        record.kind === "skipped" &&
        history !== "complete" &&
        record.start === this.base &&
        record.entries[0]?.text === "Earlier content is not loaded"
      )
        continue;
      const next = entries.findIndex(
        (entry) => (offsets.get(entry.id) ?? Infinity) >= record.start,
      );
      for (const entry of record.entries)
        insertions.push({ at: next === -1 ? entries.length : next, start: record.start, entry });
    }
    // Insert backwards so each position still refers to the original main projection.
    insertions.sort((a, b) => b.at - a.at || b.start - a.start);
    for (const { at, entry } of insertions) entries.splice(at, 0, entry);
    return this.finish("ready", entries, !linked && history === "complete" ? "unlinked" : history, {
      kind: "claude",
      nodes: Object.freeze(
        chain.map((record) => Object.freeze({ id: record.node.id, start: record.start })),
      ),
    });
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
          const parent = record.node.parent ? main.get(record.node.parent) : undefined;
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
  ): Readonly<ConversationSnapshot> {
    const entries: ConversationEntry[] = [];
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
      const notice: Partial<Record<ConversationHistory, string>> = {
        unloaded: "Earlier conversation is not loaded.",
        truncated: "Earlier conversation omitted to save memory.",
        unlinked: "Some earlier conversation entries could not be linked.",
      };
      if (notice[history])
        entries.unshift(
          Object.freeze({ id: `history:${history}`, kind: "status", text: notice[history]! }),
        );
    }
    const fingerprints = entries.map((entry) =>
      createHash("sha256").update(JSON.stringify(entry)).digest("base64url"),
    );
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
    return Object.freeze({
      state,
      entries: Object.freeze(entries),
      history,
      change,
      revision: this.revision,
      branch: branch && state === "ready" ? Object.freeze(branch) : null,
    });
  }
}
