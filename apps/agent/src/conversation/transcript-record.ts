import type { TranscriptAgent } from "./transcript-file.js";
import { TRANSCRIPT_LINE_BYTES, type TranscriptLine } from "./transcript-jsonl.js";

export const TRANSCRIPT_RECORD_BYTES = 64 * 1024;
export const TRANSCRIPT_RECORD_ENTRIES = 32;
export const TRANSCRIPT_TEXT_BYTES = 16 * 1024;
export const TRANSCRIPT_DETAIL_BYTES = 8 * 1024;
const MAX_BLOCKS = 64;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const KEY = /^[a-zA-Z0-9][a-zA-Z0-9_.:-]{0,255}$/;
const UNKNOWN = "(Something this version can't show)";

/** Presentation-only fields. Native session IDs, paths and branch links never belong here. */
export interface ConversationEntry {
  readonly id: string;
  readonly kind:
    | "user"
    | "assistant"
    | "tool-call"
    | "tool-result"
    | "status"
    | "group"
    | "unsupported";
  readonly text: string;
  readonly detail?: string;
  readonly collapsed?: boolean;
  readonly truncated?: boolean;
}

/** Private graph evidence; a projector must select the active branch before exposing entries. */
export interface TranscriptNode {
  readonly id: string;
  readonly parent: string | null | undefined;
  readonly session: string | null;
  readonly role: "user" | "assistant" | "other";
  readonly response: string | null;
  readonly scope: string;
  readonly meta: boolean;
  /** Valid main user/assistant envelope; eligible as a branch leaf after graph selection. */
  readonly mainMessage: boolean;
  readonly compact: boolean;
  readonly sourceAssistant: string | null;
  readonly calls: readonly TranscriptToolLink[];
  readonly results: readonly TranscriptToolLink[];
  readonly resultsOnly: boolean;
  readonly timestamp: string | null;
}
export interface TranscriptToolLink {
  readonly id: string;
  readonly entry: string;
}
export interface TranscriptRecord {
  readonly start: number;
  readonly end: number;
  readonly kind:
    | "message"
    | "session"
    | "compaction"
    | "status"
    | "ignored"
    | "unsupported"
    | "skipped";
  readonly entries: readonly ConversationEntry[];
  readonly node?: Readonly<TranscriptNode>;
  readonly session?: string | null;
  /** Whether a canonical Codex header describes a supported, self-contained legacy file. */
  readonly supported?: boolean;
  /** A recognized history rewrite whose meaning this adapter cannot reconstruct safely. */
  readonly invalidates?: boolean;
}

function object(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}
function key(value: unknown): string | null {
  return typeof value === "string" && value.trim() === value && KEY.test(value) ? value : null;
}
export function transcriptSessionId(value: unknown): string | null {
  return typeof value === "string" && value.length === 36 && UUID.test(value)
    ? value.toLowerCase()
    : null;
}

/** UTF-8 byte cap, valid Unicode and plain controls only, without allocating the entire input. */
export function transcriptText(value: string, limit: number): { text: string; truncated: boolean } {
  if (!Number.isSafeInteger(limit) || limit < 0 || limit > TRANSCRIPT_TEXT_BYTES)
    throw new RangeError("Invalid transcript text budget");
  let text = "";
  let bytes = 0;
  let consumed = 0;
  for (const character of value) {
    const n = character.codePointAt(0)!;
    if (consumed >= limit * 4) break;
    if ((n < 32 && n !== 9 && n !== 10) || (n >= 127 && n <= 159)) {
      consumed += character.length;
      continue;
    }
    const safe = n >= 0xd800 && n <= 0xdfff ? "�" : character;
    const count = Buffer.byteLength(safe);
    if (bytes + count > limit) break;
    text += safe;
    bytes += count;
    consumed += character.length;
  }
  return { text, truncated: consumed < value.length };
}

class Entries {
  readonly items: ConversationEntry[] = [];
  private bytes = 2;
  clipped = false;
  constructor(private readonly offset: number) {}
  get full(): boolean {
    return (
      this.items.length >= TRANSCRIPT_RECORD_ENTRIES - 1 ||
      this.bytes >= TRANSCRIPT_RECORD_BYTES - 512
    );
  }
  add(
    kind: ConversationEntry["kind"],
    text: string,
    detail?: string,
    collapsed = false,
    clipped = false,
  ): ConversationEntry | undefined {
    if (this.full) {
      this.clipped = true;
      return;
    }
    const main = transcriptText(text, TRANSCRIPT_TEXT_BYTES);
    const body = detail === undefined ? undefined : transcriptText(detail, TRANSCRIPT_DETAIL_BYTES);
    const entry: ConversationEntry = {
      id: `${this.offset}:${this.items.length}`,
      kind,
      text: main.text,
      ...(body && { detail: body.text }),
      ...(collapsed && { collapsed: true }),
      ...((clipped || main.truncated || body?.truncated) && { truncated: true }),
    };
    const bytes = Buffer.byteLength(JSON.stringify(entry)) + 1;
    if (bytes + this.bytes > TRANSCRIPT_RECORD_BYTES - 512) {
      this.clipped = true;
      return;
    }
    this.items.push(Object.freeze(entry));
    this.bytes += bytes;
    return entry;
  }
  unknown(): ConversationEntry | undefined {
    return this.add("unsupported", UNKNOWN);
  }
  finish(): readonly ConversationEntry[] {
    if (this.clipped)
      this.items.push(
        Object.freeze({
          id: `${this.offset}:${this.items.length}`,
          kind: "status",
          text: "Additional content omitted to keep this entry small.",
          truncated: true,
        }),
      );
    return Object.freeze(this.items);
  }
}

function blocks(value: unknown, entries: Entries): readonly unknown[] | null {
  if (!Array.isArray(value)) return null;
  if (value.length > MAX_BLOCKS) entries.clipped = true;
  return value.slice(0, MAX_BLOCKS);
}
function toolName(value: unknown): string {
  return typeof value === "string" ? transcriptText(value, 128).text || "Tool" : "Tool";
}
/** A short argument preview, not serialization of arbitrary nested tool objects. */
function argumentsPreview(value: unknown): { text: string; clipped: boolean } {
  if (typeof value === "string") return { text: value, clipped: false };
  const input = object(value);
  if (input) {
    for (const field of [
      "command",
      "cmd",
      "file_path",
      "path",
      "pattern",
      "query",
      "url",
      "description",
      "prompt",
    ]) {
      if (typeof input[field] === "string")
        return {
          text: `${field}: ${transcriptText(input[field], TRANSCRIPT_DETAIL_BYTES).text}`,
          clipped: true,
        };
    }
  }
  return { text: "Structured arguments omitted.", clipped: true };
}
function jsonArgumentsPreview(value: unknown): { text: string; clipped: boolean } {
  if (typeof value === "string") {
    try {
      const parsed: unknown = JSON.parse(value);
      if (object(parsed)) return argumentsPreview(parsed);
    } catch {
      // Parse errors can contain private text. Only the fixed omission notice is retained.
    }
  }
  return { text: "Structured arguments omitted.", clipped: true };
}
function resultText(value: unknown): { text: string; clipped: boolean } | null {
  if (typeof value === "string") {
    const result = transcriptText(value, TRANSCRIPT_DETAIL_BYTES);
    return { text: result.text, clipped: result.truncated };
  }
  if (!Array.isArray(value)) return null;
  let text = "";
  let used = 0;
  let clipped = value.length > MAX_BLOCKS;
  for (const item of value.slice(0, MAX_BLOCKS)) {
    const block = object(item);
    if (!block) {
      clipped = true;
      continue;
    }
    const part =
      (block.type === "text" || block.type === "input_text" || block.type === "output_text") &&
      typeof block.text === "string"
        ? block.text
        : "[Non-text content omitted]";
    const available = Math.max(0, TRANSCRIPT_DETAIL_BYTES - used - (text ? 1 : 0));
    const result = transcriptText(part, available);
    if (text && available) {
      text += "\n";
      used++;
    }
    text += result.text;
    used += Buffer.byteLength(result.text);
    clipped ||= result.truncated;
    if (!available) {
      clipped = true;
      break;
    }
  }
  return { text, clipped };
}
function addResult(
  entries: Entries,
  content: unknown,
  failed = false,
): ConversationEntry | undefined {
  const result = resultText(content);
  if (!result) {
    return entries.unknown();
  }
  return entries.add(
    "tool-result",
    failed ? "Tool error" : "Tool result",
    result.text,
    true,
    result.clipped,
  );
}

function claude(
  line: Extract<TranscriptLine, { kind: "record" }>,
  entries: Entries,
): Omit<TranscriptRecord, "start" | "end" | "entries"> {
  const value = line.value;
  const message = object(value.message);
  const id = key(value.uuid);
  const calls: TranscriptToolLink[] = [];
  const results: TranscriptToolLink[] = [];
  const side =
    value.isSidechain === true ||
    typeof value.agentId === "string" ||
    typeof value.teamName === "string";
  const meta = value.isMeta === true || message?.channel === "analysis";
  const compact =
    value.isCompactSummary === true ||
    (value.type === "system" && value.subtype === "compact_boundary");
  let resultsOnly = true;
  let messageValid = false;
  const role = value.type === "user" || value.type === "assistant" ? value.type : "other";
  const node = (): Readonly<TranscriptNode> | undefined =>
    id
      ? Object.freeze({
          id,
          parent: value.parentUuid === null ? null : (key(value.parentUuid) ?? undefined),
          session: transcriptSessionId(value.sessionId),
          role,
          response: key(message?.id),
          scope: side ? `side:${key(value.agentId) ?? key(value.teamName) ?? "unknown"}` : "main",
          meta,
          mainMessage: messageValid && !meta && !side,
          compact,
          sourceAssistant: key(value.sourceToolAssistantUUID),
          calls: Object.freeze(calls),
          results: Object.freeze(results),
          resultsOnly: resultsOnly && results.length > 0,
          timestamp:
            typeof value.timestamp === "string" &&
            value.timestamp.endsWith("Z") &&
            /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?Z$/.test(value.timestamp)
              ? value.timestamp
              : null,
        })
      : undefined;
  let kind: TranscriptRecord["kind"] = "ignored";
  if (meta) {
    // Compaction flags cannot turn internal context or reasoning into visible text.
  } else if (
    role !== "other" &&
    message?.channel !== undefined &&
    message.channel !== null &&
    message.channel !== "final" &&
    message.channel !== "commentary"
  ) {
    entries.unknown();
    kind = "unsupported";
  } else if (compact && id) {
    const boundary = value.type === "system" && value.subtype === "compact_boundary";
    messageValid =
      role !== "other" &&
      message?.role === role &&
      (typeof message.content === "string" || Array.isArray(message.content));
    if (boundary || messageValid) {
      const summary = boundary ? null : resultText(message?.content);
      if (!boundary)
        entries.add("group", "Conversation summary", summary?.text, true, summary?.clipped);
      kind = "compaction";
    } else {
      entries.unknown();
      kind = "unsupported";
    }
  } else if (role !== "other") {
    kind = "message";
    if (!id || !message || message.role !== role) {
      entries.unknown();
      kind = "unsupported";
    } else if (!meta) {
      messageValid = typeof message.content === "string" || Array.isArray(message.content);
      if (typeof message.content === "string") {
        entries.add(role, message.content);
        resultsOnly = false;
      } else {
        const content = blocks(message.content, entries);
        if (!content) {
          entries.unknown();
          kind = "unsupported";
        }
        for (const item of content ?? []) {
          if (entries.full) {
            entries.clipped = true;
            break;
          }
          const block = object(item);
          if (!block) {
            entries.unknown();
            resultsOnly = false;
            continue;
          }
          if (block.type === "tool_result" && role === "user") {
            const tool = key(block.tool_use_id);
            const entry = addResult(entries, block.content ?? "", block.is_error === true);
            if (tool && entry) results.push(Object.freeze({ id: tool, entry: entry.id }));
          } else {
            resultsOnly = false;
            if (block.type === "text" && typeof block.text === "string")
              entries.add(role, block.text);
            else if (block.type === "tool_use" && role === "assistant") {
              const tool = key(block.id);
              const preview = argumentsPreview(block.input);
              const entry = entries.add(
                "tool-call",
                toolName(block.name),
                preview.text,
                true,
                preview.clipped,
              );
              if (tool && entry) calls.push(Object.freeze({ id: tool, entry: entry.id }));
            } else if (block.type === "thinking" || block.type === "redacted_thinking") {
              /* internal reasoning */
            } else if (block.type === "image" || block.type === "document")
              entries.add("status", "Non-text content omitted");
            else entries.unknown();
          }
        }
      }
    }
  } else if (
    typeof value.type !== "string" ||
    ![
      "progress",
      "system",
      "attachment",
      "file-history-snapshot",
      "queue-operation",
      "summary",
      "custom-title",
      "tag",
      "last-prompt",
    ].includes(value.type)
  ) {
    entries.unknown();
    kind = "unsupported";
  }
  const evidence = node();
  return { kind, ...(evidence && { node: evidence }) };
}

function codex(
  line: Extract<TranscriptLine, { kind: "record" }>,
  entries: Entries,
): Omit<TranscriptRecord, "start" | "end" | "entries"> {
  const value = line.value;
  const payload = object(value.payload);
  const metadata = object(value.metadata);
  if (value.type === "session_meta")
    return {
      kind: "session",
      session: transcriptSessionId(payload?.id),
      supported:
        !!payload &&
        (payload.history_mode === undefined || payload.history_mode === "legacy") &&
        payload.history_base == null &&
        payload.subagent_history_start_ordinal == null,
    };
  if (
    value.type === "turn_context" ||
    value.type === "token_usage_record" ||
    value.type === "world_state" ||
    value.type === "security_risk_score" ||
    value.type === "retained_context" ||
    value.type === "realtime_item"
  )
    return { kind: "ignored" };
  if (value.type === "compacted" && payload) {
    entries.add(
      "group",
      "Conversation summary",
      typeof payload.message === "string" ? payload.message : undefined,
      true,
    );
    return { kind: "compaction" };
  }
  if (
    value.type === "inter_agent_communication" ||
    value.type === "inter_agent_communication_metadata"
  ) {
    entries.add(
      "group",
      "Subagent activity",
      "This activity is recorded separately from the main conversation.",
      true,
    );
    return { kind: "status" };
  }
  if (value.type === "event_msg" && payload) {
    if (payload.type === "user_message") {
      // Canonical legacy display input. role:user response items also contain harness context.
      if (payload.kind !== undefined && payload.kind !== "plain") return { kind: "ignored" };
      if (typeof payload.message === "string") entries.add("user", payload.message);
      else entries.unknown();
      return { kind: "message" };
    }
    if (payload.type === "thread_rolled_back") {
      entries.unknown();
      return { kind: "unsupported", invalidates: true };
    }
    const status: Record<string, string> = {
      task_started: "Working",
      turn_started: "Working",
      task_complete: "Complete",
      turn_complete: "Complete",
      turn_aborted: "Stopped",
      error: "Agent reported an error",
    };
    if (typeof payload.type === "string" && Object.hasOwn(status, payload.type)) {
      entries.add("status", status[payload.type]!);
      return { kind: "status" };
    }
    if (
      typeof payload.type === "string" &&
      [
        "token_count",
        "agent_message",
        "agent_reasoning",
        "agent_reasoning_raw_content",
        "thread_settings_applied",
        "thread_goal_updated",
        "context_compacted",
        "patch_apply_end",
        "mcp_tool_call_end",
        "web_search_end",
        "image_generation_end",
        "item_completed",
      ].includes(payload.type)
    )
      return { kind: "ignored" };
    if (payload.type === "sub_agent_activity") {
      entries.add("group", "Subagent activity", undefined, true);
      return { kind: "status" };
    }
  }
  if (value.type === "response_item" && payload) {
    if (metadata?.inherited_user_message === true || metadata?.delivered_assistant_message != null)
      return { kind: "ignored" };
    if (
      typeof payload.type === "string" &&
      [
        "reasoning",
        "additional_tools",
        "configuration_update",
        "compaction",
        "context_compaction",
      ].includes(payload.type)
    )
      return { kind: "ignored" };
    const tools: Record<string, string> = {
      local_shell_call: "Shell command",
      tool_search_call: "Tool search",
      web_search_call: "Web search",
      image_generation_call: "Image generation",
    };
    if (typeof payload.type === "string" && Object.hasOwn(tools, payload.type)) {
      entries.add("tool-call", tools[payload.type]!, undefined, true);
      return { kind: "message" };
    }
    if (payload.type === "tool_search_output") {
      entries.add("tool-result", "Tool search result", undefined, true);
      return { kind: "message" };
    }
    if (payload.type === "agent_message") {
      entries.add("group", "Subagent activity", undefined, true);
      return { kind: "message" };
    }
    if (payload.type === "message") {
      if (
        payload.role === "system" ||
        payload.role === "developer" ||
        payload.role === "user" ||
        payload.channel === "analysis"
      )
        return { kind: "ignored" };
      if (
        payload.role === "assistant" &&
        (payload.channel === undefined ||
          payload.channel === null ||
          payload.channel === "final" ||
          payload.channel === "commentary") &&
        (payload.phase === undefined ||
          payload.phase === null ||
          payload.phase === "commentary" ||
          payload.phase === "partial_answer" ||
          payload.phase === "final_answer")
      ) {
        if (metadata?.compaction_output === true) {
          const summary = resultText(payload.content);
          entries.add("group", "Conversation summary", summary?.text, true, summary?.clipped);
          return { kind: "compaction" };
        }
        const content = blocks(payload.content, entries);
        if (!content) entries.unknown();
        for (const item of content ?? []) {
          if (entries.full) {
            entries.clipped = true;
            break;
          }
          const block = object(item);
          if (
            block &&
            (block.type === "input_text" || block.type === "output_text") &&
            typeof block.text === "string"
          )
            entries.add(payload.role, block.text);
          else if (block?.type === "input_image" || block?.type === "input_audio")
            entries.add("status", "Non-text content omitted");
          else entries.unknown();
        }
        return { kind: "message" };
      }
    } else if (payload.type === "function_call" || payload.type === "custom_tool_call") {
      const preview =
        payload.type === "function_call"
          ? jsonArgumentsPreview(payload.arguments)
          : argumentsPreview(payload.input);
      entries.add("tool-call", toolName(payload.name), preview.text, true, preview.clipped);
      return { kind: "message" };
    } else if (
      payload.type === "function_call_output" ||
      payload.type === "custom_tool_call_output"
    ) {
      addResult(entries, payload.output);
      return { kind: "message" };
    }
  }
  entries.unknown();
  return { kind: "unsupported" };
}

/** Decode only bounded, completed JSONL lines. This is not branch selection or delivery authority. */
export function decodeTranscriptRecord(
  agent: TranscriptAgent,
  line: TranscriptLine,
): Readonly<TranscriptRecord> {
  if (agent !== "claude" && agent !== "codex") throw new TypeError("Unsupported transcript agent");
  if (
    !Number.isSafeInteger(line.start) ||
    !Number.isSafeInteger(line.end) ||
    line.start < 0 ||
    line.end <= line.start
  )
    throw new RangeError("Invalid transcript record range");
  const entries = new Entries(line.start);
  let decoded: Omit<TranscriptRecord, "start" | "end" | "entries">;
  if (line.kind === "skipped") {
    entries.add(
      "status",
      line.reason === "partial-prefix"
        ? "Earlier content is not loaded"
        : "A transcript entry could not be read",
      undefined,
      false,
      true,
    );
    decoded = { kind: "skipped" };
  } else if (line.end - line.start > TRANSCRIPT_LINE_BYTES + 1) {
    entries.add("status", "A transcript entry exceeded the read limit", undefined, false, true);
    decoded = { kind: "skipped" };
  } else decoded = agent === "claude" ? claude(line, entries) : codex(line, entries);
  return Object.freeze({ start: line.start, end: line.end, ...decoded, entries: entries.finish() });
}

/** Canonical Codex identity is the first metadata record, never inherited fork metadata later on. */
export class CodexTranscriptHeader {
  private state: "pending" | "verified" | "mismatch" | "unsupported" | "closed" = "pending";
  private readonly expected: string;
  constructor(session: string) {
    const parsed = transcriptSessionId(session);
    if (!parsed) throw new TypeError("Invalid transcript session identity");
    this.expected = parsed;
  }
  get status() {
    return this.state;
  }
  observe(record: TranscriptRecord): void {
    if (this.state !== "pending") return;
    if (
      record.start !== 0 ||
      record.kind !== "session" ||
      !record.session ||
      record.supported !== true
    )
      this.state = "unsupported";
    else this.state = record.session === this.expected ? "verified" : "mismatch";
  }
  close(): void {
    this.state = "closed";
  }
}
