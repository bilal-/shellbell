import type { TranscriptAgent } from "./transcript-file.js";
import { transcriptVersion } from "./transcript-formats.js";
import { TRANSCRIPT_LINE_BYTES, type TranscriptLine } from "./transcript-jsonl.js";
import {
  TRANSCRIPT_BLOCKS,
  TRANSCRIPT_OMITTED,
  TRANSCRIPT_STRING_CHARS,
  type TranscriptOutline,
} from "./transcript-outline.js";

/** The text of the cut-off line a read window starts inside; the document hides it. */
export const TRANSCRIPT_PARTIAL_PREFIX = "Earlier content is not loaded";
export const TRANSCRIPT_RECORD_BYTES = 64 * 1024;
export const TRANSCRIPT_RECORD_ENTRIES = 32;
export const TRANSCRIPT_TEXT_BYTES = TRANSCRIPT_STRING_CHARS;
export const TRANSCRIPT_DETAIL_BYTES = 8 * 1024;
const MAX_BLOCKS = TRANSCRIPT_BLOCKS;
const CLAUDE_BOOKKEEPING: ReadonlySet<string> = new Set([
  "progress",
  "system",
  "attachment",
  "file-history-snapshot",
  "queue-operation",
  "summary",
  "custom-title",
  "tag",
  "last-prompt",
  // Session bookkeeping newer Claude Code versions interleave with the conversation.
  "ai-title",
  "agent-name",
  "agent-setting",
  "mode",
  "permission-mode",
  "atis-latch",
  "cost-state",
  "pr-link",
  "continued-in",
  "file-history-delta",
  "api-request",
  "api-request-blob",
  "api-request-shape",
]);
const CODEX_IGNORED_EVENTS: ReadonlySet<string> = new Set([
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
]);
const CODEX_IGNORED_ITEMS: ReadonlySet<string> = new Set([
  "reasoning",
  "additional_tools",
  "configuration_update",
  "compaction",
  "context_compaction",
]);
const CODEX_STATUS: Readonly<Record<string, string>> = {
  task_started: "Working",
  turn_started: "Working",
  task_complete: "Complete",
  turn_complete: "Complete",
  turn_aborted: "Stopped",
  error: "Agent reported an error",
};

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
  /** The agent's own version that wrote this record, when it says. */
  readonly version?: string;
  /**
   * Gemini writes a message again whenever it changes; this record replaces the earlier one with
   * the same ID, in its place.
   */
  readonly message?: string;
  /** Gemini removed this message and everything after it, as after `/rewind`. */
  readonly rewind?: string;
  /** Gemini replaced its whole message list; earlier records no longer apply. */
  readonly resets?: boolean;
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
  constructor(
    /** Each row's ID prefix: the record's byte offset, or for Gemini its message's ID. */
    private readonly offset: number | string,
    /** The record was too large to read whole, so some of its text was replaced. */
    private readonly outlined = false,
  ) {}
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
    if (
      this.outlined &&
      (text.includes(TRANSCRIPT_OMITTED) || detail?.includes(TRANSCRIPT_OMITTED))
    )
      clipped = true;
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
const SUMMARY_BYTES = 120;
interface ArgumentsPreview {
  readonly text: string;
  readonly clipped: boolean;
  /** First line of the main argument, shown beside the tool name. */
  readonly summary?: string;
  /** The summary already shows the whole argument, so details would only repeat it. */
  readonly complete?: boolean;
}
function preview(value: string, field?: string): ArgumentsPreview {
  const body = transcriptText(value, TRANSCRIPT_DETAIL_BYTES);
  const line = body.text.trim().split("\n", 1)[0]!.trim();
  const head = transcriptText(line, SUMMARY_BYTES);
  const whole = !head.truncated && line === body.text && !body.truncated;
  return {
    text: field ? `${field}: ${body.text}` : body.text,
    clipped: body.truncated,
    ...(line && { summary: whole ? head.text : `${head.text}…` }),
    ...(whole && { complete: true }),
  };
}
const ARGUMENT_FIELDS = [
  "command",
  "cmd",
  "file_path",
  "path",
  "pattern",
  "query",
  "url",
  "description",
  "prompt",
] as const;
/** A short argument preview, not serialization of arbitrary nested tool objects. */
function argumentsPreview(value: unknown): ArgumentsPreview {
  if (typeof value === "string") return preview(value);
  const input = object(value);
  if (input) {
    for (const field of ARGUMENT_FIELDS) {
      const argument = input[field];
      if (typeof argument === "string") return preview(argument, field);
    }
  }
  return { text: "Structured arguments omitted.", clipped: false };
}
function jsonArgumentsPreview(value: unknown): ArgumentsPreview {
  // Arguments too long to read whole, from a line too large to buffer, can't be parsed.
  if (value === TRANSCRIPT_OMITTED)
    return { text: "Arguments too large to show here.", clipped: true };
  if (typeof value === "string") {
    try {
      const parsed: unknown = JSON.parse(value);
      if (object(parsed)) return argumentsPreview(parsed);
    } catch {
      // Parse errors can contain private text. Only the fixed omission notice is retained.
    }
  }
  return { text: "Structured arguments omitted.", clipped: false };
}
/** One line per call, such as `Bash · git status`; the full argument stays in details. */
function addCall(entries: Entries, name: unknown, args: ArgumentsPreview) {
  const tool = toolName(name);
  return entries.add(
    "tool-call",
    args.summary ? `${tool} · ${args.summary}` : tool,
    args.complete ? undefined : args.text,
    true,
    args.clipped,
  );
}
/** Like transcriptText, but keeps the end of the input, where errors and summaries usually are. */
export function transcriptTail(value: string, limit: number): { text: string; truncated: boolean } {
  if (!Number.isSafeInteger(limit) || limit < 0 || limit > TRANSCRIPT_TEXT_BYTES)
    throw new RangeError("Invalid transcript text budget");
  const parts: string[] = [];
  let bytes = 0;
  let consumed = 0;
  let index = value.length;
  while (index > 0 && consumed < limit * 4) {
    const low = value.charCodeAt(index - 1);
    const high = index > 1 ? value.charCodeAt(index - 2) : 0;
    const width = low >= 0xdc00 && low <= 0xdfff && high >= 0xd800 && high <= 0xdbff ? 2 : 1;
    const character = value.slice(index - width, index);
    const n = character.codePointAt(0)!;
    if (!((n < 32 && n !== 9 && n !== 10) || (n >= 127 && n <= 159))) {
      const safe = n >= 0xd800 && n <= 0xdfff ? "�" : character;
      const count = Buffer.byteLength(safe);
      if (bytes + count > limit) break;
      parts.push(safe);
      bytes += count;
    }
    index -= width;
    consumed += width;
  }
  return { text: parts.reverse().join(""), truncated: index > 0 };
}

/** Successful output is context; a failure's last lines usually explain it. */
const RESULT_BYTES = 1024;
function resultText(
  value: unknown,
  limit = TRANSCRIPT_DETAIL_BYTES,
  tail = false,
): { text: string; clipped: boolean } | null {
  const cut = (text: string) => (tail ? transcriptTail(text, limit) : transcriptText(text, limit));
  if (typeof value === "string") {
    const result = cut(value);
    return { text: result.text, clipped: result.truncated };
  }
  if (!Array.isArray(value)) return null;
  const parts: string[] = [];
  let clipped = value.length > MAX_BLOCKS;
  for (const item of value.slice(0, MAX_BLOCKS)) {
    const block = object(item);
    if (!block) {
      clipped = true;
      continue;
    }
    parts.push(
      (block.type === "text" || block.type === "input_text" || block.type === "output_text") &&
        typeof block.text === "string"
        ? block.text
        : "[Non-text content omitted]",
    );
  }
  // Decoded lines are already bounded by TRANSCRIPT_LINE_BYTES, so joining them is bounded too.
  const result = cut(parts.join("\n"));
  return { text: result.text, clipped: clipped || result.truncated };
}
function addResult(
  entries: Entries,
  content: unknown,
  failed = false,
): ConversationEntry | undefined {
  const result = failed
    ? resultText(content, TRANSCRIPT_DETAIL_BYTES, true)
    : resultText(content, RESULT_BYTES);
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

const CLAUDE_WRAPPED = /^\s*<([a-z-]+)>/;

/**
 * Claude Code records some things done on the owner's behalf as user text in tags: background
 * task notices, slash commands and `!` shell commands. Its own screen shows each as one line,
 * not as something the owner typed, so these become a short notice or the command itself.
 */
function claudeUserText(entries: Entries, text: string): void {
  const tag = CLAUDE_WRAPPED.exec(text)?.[1];
  const inner = (name: string) =>
    new RegExp(`<${name}>([\\s\\S]*?)</${name}>`).exec(text)?.[1]?.trim() || undefined;
  const firstLine = (value: string | undefined) =>
    value
      ?.split("\n")
      .map((line) => line.trim())
      .find(Boolean);
  switch (tag) {
    case "task-notification":
      entries.add("status", inner("summary") ?? "A background task finished");
      return;
    case "command-name":
    case "command-message": {
      const name = inner("command-name") ?? `/${inner("command-message") ?? ""}`;
      entries.add("user", [name, inner("command-args")].filter(Boolean).join(" "));
      return;
    }
    case "bash-input":
      entries.add("user", `! ${inner("bash-input") ?? ""}`);
      return;
    case "local-command-stdout":
    case "local-command-stderr":
    case "bash-stdout":
    case "bash-stderr": {
      const line = firstLine(inner(tag)) ?? firstLine(inner("bash-stderr"));
      if (line) entries.add("status", line);
      return;
    }
    case "local-command-caveat":
    case "system-reminder":
      return;
    default:
      entries.add("user", text);
  }
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
  const compactBoundary = value.type === "system" && value.subtype === "compact_boundary";
  const compact = value.isCompactSummary === true || compactBoundary;
  let resultsOnly = true;
  let messageValid = false;
  const role = value.type === "user" || value.type === "assistant" ? value.type : "other";
  const node = (): Readonly<TranscriptNode> | undefined =>
    id
      ? Object.freeze({
          id,
          // A compaction boundary starts a new chain but names the message it followed, so
          // older pages continue past the summary into the conversation before it.
          parent:
            value.parentUuid === null
              ? compactBoundary
                ? (key(value.logicalParentUuid) ?? null)
                : null
              : (key(value.parentUuid) ?? undefined),
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
        if (role === "user") claudeUserText(entries, message.content);
        else entries.add(role, message.content);
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
            if (block.type === "text" && typeof block.text === "string") {
              if (role === "user") claudeUserText(entries, block.text);
              else entries.add(role, block.text);
            } else if (block.type === "tool_use" && role === "assistant") {
              const tool = key(block.id);
              const entry = addCall(entries, block.name, argumentsPreview(block.input));
              if (tool && entry) calls.push(Object.freeze({ id: tool, entry: entry.id }));
            } else if (block.type === "server_tool_use" && role === "assistant") {
              // Tools the API runs itself, such as web search; their results arrive inline.
              addCall(entries, block.name, argumentsPreview(block.input));
            } else if (
              typeof block.type === "string" &&
              block.type.endsWith("_tool_result") &&
              role === "assistant"
            ) {
              if (resultText(block.content ?? "")) addResult(entries, block.content ?? "");
              else entries.add("tool-result", "Tool result", "[Non-text content omitted]", true);
            } else if (block.type === "thinking" || block.type === "redacted_thinking") {
              /* internal reasoning */
            } else if (block.type === "image" || block.type === "document")
              entries.add("status", "Non-text content omitted");
            else entries.unknown();
          }
        }
      }
    }
  } else if (typeof value.type !== "string" || !CLAUDE_BOOKKEEPING.has(value.type as string)) {
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
        // Paginated files without a history base hold their whole conversation, like legacy.
        (payload.history_mode === undefined ||
          payload.history_mode === "legacy" ||
          payload.history_mode === "paginated") &&
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

    if (typeof payload.type === "string" && Object.hasOwn(CODEX_STATUS, payload.type)) {
      entries.add("status", CODEX_STATUS[payload.type]!);
      return { kind: "status" };
    }
    if (typeof payload.type === "string" && CODEX_IGNORED_EVENTS.has(payload.type as string))
      return { kind: "ignored" };
    if (payload.type === "sub_agent_activity") {
      entries.add("group", "Subagent activity", undefined, true);
      return { kind: "status" };
    }
  }
  if (value.type === "response_item" && payload) {
    if (metadata?.inherited_user_message === true || metadata?.delivered_assistant_message != null)
      return { kind: "ignored" };
    if (typeof payload.type === "string" && CODEX_IGNORED_ITEMS.has(payload.type as string))
      return { kind: "ignored" };
    if (payload.type === "tool_search_call") {
      entries.add("tool-call", "Tool search", undefined, true);
      return { kind: "message" };
    }
    // These never get a result record. As calls, the phone would pair the next tool's result
    // with them, because results carry no call ID on the wire, so they are one-line work.
    const work: Record<string, string> = {
      local_shell_call: "Shell command",
      web_search_call: "Web search",
      image_generation_call: "Image generation",
    };
    if (typeof payload.type === "string" && Object.hasOwn(work, payload.type)) {
      entries.add("group", work[payload.type]!, undefined, true);
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
      // Paginated files have no user-message events. A typed prompt is the user record the
      // input order counts; harness context such as AGENTS.md is a user record without one.
      const source = object(object(metadata?.retained_source)?.id);
      if (
        payload.role === "user" &&
        source?.role === "user" &&
        typeof metadata?.user_input_order === "number" &&
        metadata.client_authored !== true
      ) {
        const content = blocks(payload.content, entries);
        if (!content) entries.unknown();
        for (const item of content ?? []) {
          const block = object(item);
          if (block?.type === "input_text" && typeof block.text === "string")
            entries.add("user", block.text);
          else if (block?.type === "input_image" || block?.type === "input_audio")
            entries.add("status", "Non-text content omitted");
          else entries.unknown();
        }
        return { kind: "message" };
      }
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
      addCall(
        entries,
        payload.name,
        payload.type === "function_call"
          ? jsonArgumentsPreview(payload.arguments)
          : argumentsPreview(payload.input),
      );
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

/** Context Gemini adds as a message of its own, wrapped in a tag it uses for that alone. */
const GEMINI_WRAPPED = /^\s*<(session_context)>[\s\S]*<\/\1>\s*$/;
function geminiText(value: unknown, entries: Entries): string | null {
  if (typeof value === "string") return value;
  const items = blocks(value, entries);
  if (!items) return null;
  return items
    .map((item) => {
      const text = object(item)?.text;
      return typeof text === "string" ? text : "[Non-text content omitted]";
    })
    .join("\n");
}
/** One Gemini message: the prompt, or the reply's text then each tool call and its result. */
function geminiMessage(message: Record<string, unknown>, entries: Entries): void {
  if (message.type === "user") {
    // `displayContent` is what the owner typed; `content` can hold the text of attached files.
    const text = geminiText(message.displayContent ?? message.content, entries);
    if (text === null) entries.unknown();
    else if (!GEMINI_WRAPPED.test(text) && text.trim()) entries.add("user", text);
    return;
  }
  if (message.type === "info" || message.type === "warning" || message.type === "error") {
    const text = geminiText(message.content, entries);
    if (text?.trim()) entries.add("status", text);
    return;
  }
  if (message.type !== "gemini") {
    entries.unknown();
    return;
  }
  // `thoughts`, `tokens` and `model` are never read, like other agents' reasoning.
  const text = geminiText(message.content, entries);
  if (text?.trim()) entries.add("assistant", text);
  const calls = blocks(message.toolCalls ?? [], entries) ?? [];
  for (const item of calls) {
    const call = object(item);
    if (!call) {
      entries.unknown();
      continue;
    }
    if (call.name === "invoke_agent") {
      entries.add("group", "Subagent activity", undefined, true);
      continue;
    }
    const args =
      typeof call.description === "string" && call.description.trim()
        ? preview(call.description)
        : argumentsPreview(call.args);
    addCall(entries, call.displayName ?? call.name, args);
    if (call.status === "scheduled" || call.status === "executing" || call.status === "validating")
      continue;
    const failed = call.status === "error" || call.status === "cancelled";
    const response = object(
      object(object((Array.isArray(call.result) ? call.result : [])[0])?.functionResponse)
        ?.response,
    );
    const display = call.resultDisplay;
    const output =
      typeof display === "string"
        ? display
        : object(display) && typeof object(display)!.fileName === "string"
          ? `${String(object(display)!.fileName).split("/").pop()}`
          : (response?.error ?? response?.output);
    addResult(entries, typeof output === "string" ? output : "", failed);
  }
}
function gemini(
  line: Extract<TranscriptLine, { kind: "record" }>,
  entries: Entries,
): Omit<TranscriptRecord, "start" | "end" | "entries"> {
  const value = line.value;
  if (line.start === 0 && "sessionId" in value && "projectHash" in value) {
    return {
      kind: "session",
      session: transcriptSessionId(value.sessionId),
      // Subagent transcripts are separate files with their own kind; only the main one is read.
      supported: value.kind === undefined || value.kind === "main",
    };
  }
  if (typeof value.$rewindTo === "string") {
    const id = key(value.$rewindTo);
    return id ? { kind: "status", rewind: id } : { kind: "unsupported", invalidates: true };
  }
  const set = object(value.$set);
  if (set) {
    if (!Array.isArray(set.messages)) return { kind: "ignored" };
    for (const item of blocks(set.messages, entries) ?? []) {
      const message = object(item);
      if (message) geminiMessage(message, entries);
      else entries.unknown();
    }
    return { kind: "message", resets: true };
  }
  const id = key(value.id);
  if (!id || typeof value.type !== "string") {
    entries.unknown();
    return { kind: "unsupported" };
  }
  geminiMessage(value, entries);
  return { kind: "message", message: id };
}

const LEAF: TranscriptOutline = {};
function outline(keys: readonly string[], nested: Record<string, TranscriptOutline> = {}) {
  return { keys: { ...Object.fromEntries(keys.map((name) => [name, LEAF])), ...nested } };
}
const ARGUMENTS = outline(ARGUMENT_FIELDS);
const TEXT_BLOCKS: TranscriptOutline = { items: outline(["type", "text"]) };
/**
 * Every field the decoders above read. A line too large to buffer is read down to these,
 * so it still classifies and links like any other record. Keep in step with the decoders.
 */
const GEMINI_MESSAGE = outline(["id", "type"], {
  content: { items: outline(["text"]) },
  displayContent: { items: outline(["text"]) },
  toolCalls: {
    items: outline(["name", "displayName", "description", "status"], {
      args: ARGUMENTS,
      resultDisplay: outline(["fileName"]),
      result: {
        items: outline([], {
          functionResponse: outline([], { response: outline(["output", "error"]) }),
        }),
      },
    }),
  },
});
const OUTLINES: Readonly<Record<"claude" | "codex" | "gemini", TranscriptOutline>> = {
  // Gemini's `thoughts` are left out, so they are never buffered.
  gemini: {
    keys: {
      ...GEMINI_MESSAGE.keys,
      sessionId: LEAF,
      projectHash: LEAF,
      kind: LEAF,
      $rewindTo: LEAF,
      $set: outline([], { messages: { items: GEMINI_MESSAGE } }),
    },
  },
  claude: outline(
    [
      "uuid",
      "parentUuid",
      "logicalParentUuid",
      "type",
      "subtype",
      "sessionId",
      "timestamp",
      "isSidechain",
      "agentId",
      "teamName",
      "isMeta",
      "isCompactSummary",
      "sourceToolAssistantUUID",
      "version",
    ],
    {
      message: outline(["role", "channel", "id"], {
        content: {
          items: outline(["type", "text", "id", "name", "tool_use_id", "is_error"], {
            input: ARGUMENTS,
            content: TEXT_BLOCKS,
          }),
        },
      }),
    },
  ),
  codex: outline(["type"], {
    payload: outline(
      [
        "id",
        "history_mode",
        "history_base",
        "subagent_history_start_ordinal",
        "type",
        "kind",
        "message",
        "role",
        "channel",
        "phase",
        "name",
        "arguments",
        "cli_version",
      ],
      { content: TEXT_BLOCKS, input: ARGUMENTS, output: TEXT_BLOCKS },
    ),
    metadata: outline(
      [
        "inherited_user_message",
        "delivered_assistant_message",
        "compaction_output",
        "user_input_order",
        "client_authored",
      ],
      { retained_source: outline([], { id: outline(["role"]) }) },
    ),
  }),
};
/**
 * Every string value the decoders compare against, for tools that must keep a record's kind,
 * such as the fixture anonymiser. Not used for decoding.
 */
/** Gemini tool call states the decoder tells apart. */
const GEMINI_STATUSES = ["success", "error", "cancelled", "scheduled", "executing", "validating"];
export const TRANSCRIPT_VOCABULARY: ReadonlySet<string> = new Set([
  ...GEMINI_STATUSES,
  ...CLAUDE_BOOKKEEPING,
  ...CODEX_IGNORED_EVENTS,
  ...CODEX_IGNORED_ITEMS,
  ...Object.keys(CODEX_STATUS),
]);
/** Agents whose transcripts are JSONL files, read by the decoders above. */
const JSONL_AGENTS: ReadonlySet<string> = new Set(["claude", "codex", "gemini"]);
export function transcriptOutline(agent: TranscriptAgent): TranscriptOutline {
  if (!JSONL_AGENTS.has(agent)) throw new TypeError("Unsupported transcript agent");
  return OUTLINES[agent as keyof typeof OUTLINES];
}

/** Decode only bounded, completed JSONL lines. This is not branch selection or delivery authority. */
export function decodeTranscriptRecord(
  agent: TranscriptAgent,
  line: TranscriptLine,
): Readonly<TranscriptRecord> {
  if (!JSONL_AGENTS.has(agent)) throw new TypeError("Unsupported transcript agent");
  if (
    !Number.isSafeInteger(line.start) ||
    !Number.isSafeInteger(line.end) ||
    line.start < 0 ||
    line.end <= line.start
  )
    throw new RangeError("Invalid transcript record range");
  const outlined = line.kind === "record" && line.outlined === true;
  // Gemini writes a message again at a new offset whenever it changes; IDs from its message ID
  // let the phone update those rows in place rather than add the new version beside the old.
  const message =
    agent === "gemini" && line.kind === "record" && typeof line.value.$set !== "object"
      ? key(line.value.id)
      : null;
  const entries = new Entries(message ? `gemini:${message}` : line.start, outlined);
  let decoded: Omit<TranscriptRecord, "start" | "end" | "entries">;
  if (line.kind === "skipped") {
    entries.add(
      "status",
      line.reason === "partial-prefix"
        ? TRANSCRIPT_PARTIAL_PREFIX
        : "A transcript entry could not be read",
      undefined,
      false,
      true,
    );
    decoded = { kind: "skipped" };
  } else if (!outlined && line.end - line.start > TRANSCRIPT_LINE_BYTES + 1) {
    entries.add("status", "A transcript entry exceeded the read limit", undefined, false, true);
    decoded = { kind: "skipped" };
  } else {
    decoded =
      agent === "claude"
        ? claude(line, entries)
        : agent === "codex"
          ? codex(line, entries)
          : gemini(line, entries);
    const version = transcriptVersion(
      agent === "claude" ? line.value.version : object(line.value.payload)?.cli_version,
    );
    if (version && (agent === "claude" || decoded.kind === "session"))
      decoded = { ...decoded, version };
  }
  return Object.freeze({ start: line.start, end: line.end, ...decoded, entries: entries.finish() });
}

/**
 * A transcript's identity is its first record: Codex's session metadata or Gemini's header,
 * never metadata inherited from a fork later on.
 */
export class TranscriptHeader {
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
