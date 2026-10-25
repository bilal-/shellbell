/**
 * Rules for anonymising agent transcripts into test fixtures, shared by the fixture scripts and
 * the test that checks committed fixtures. Every string is replaced unless it is on an explicit
 * list: a key the decoders read, a value the decoders compare against, a known built-in tool
 * name, or a plain version number. Nothing is kept for looking harmless.
 */
import { createHmac, randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { TranscriptOutline } from "../src/conversation/transcript-outline.js";
import { TRANSCRIPT_VOCABULARY, transcriptOutline } from "../src/conversation/transcript-record.js";

export const FIXTURE_SESSION = "11111111-1111-4111-8111-111111111111";
export const FIXTURE_TIME = "2026-01-01T00:00:00.000Z";
const PHRASE = "lorem ipsum dolor sit amet ";
const VERSION = /^\d{1,6}(?:\.\d{1,6}){0,3}$/;

/** Filler of about the original length, so sizes stay realistic without any content. */
export function filler(length: number): string {
  const size = Math.min(Math.max(length, 1), 160);
  return (
    PHRASE.repeat(Math.ceil(size / PHRASE.length))
      .slice(0, size)
      .trimEnd() || "x"
  );
}
/** Protobuf filler is a raw prefix of the phrase, cut at any byte. */
export function isFillerBytes(value: string): boolean {
  return value.length > 0 && PHRASE.repeat(8).startsWith(value);
}
export function isFiller(value: string): boolean {
  return (
    value === "x" ||
    (value.length > 0 && PHRASE.repeat(8).startsWith(value) && !value.endsWith(" "))
  );
}

/** Every key the decoders read, from their own outlines, plus the structure around them. */
function outlineKeys(outline: TranscriptOutline, into: Set<string>): Set<string> {
  for (const [key, child] of Object.entries(outline.keys ?? {})) {
    into.add(key);
    outlineKeys(child, into);
  }
  if (outline.items) outlineKeys(outline.items, into);
  return into;
}
export const FIXTURE_KEYS: ReadonlySet<string> = outlineKeys(
  transcriptOutline("codex"),
  outlineKeys(transcriptOutline("claude"), new Set(["version", "cli_version"])),
);

/**
 * Values the decoders compare against: their declared vocabulary and the string literals in
 * their source, which covers inline comparisons such as `block.type === "tool_use"`.
 */
export const FIXTURE_VALUES: ReadonlySet<string> = new Set([
  ...TRANSCRIPT_VOCABULARY,
  ...[
    ...readFileSync(
      join(import.meta.dirname, "../src/conversation/transcript-record.ts"),
      "utf8",
    ).matchAll(/"([a-z][a-z0-9_-]{1,40})"/g),
  ].map((match) => match[1]!),
]);
/** Fields whose value names a kind of record, block or state, never content. */
const ENUM_FIELDS = new Set([
  "type",
  "subtype",
  "role",
  "channel",
  "phase",
  "history_mode",
  "kind",
]);
const VERSION_FIELDS = new Set(["version", "cli_version"]);

/** Built-in tools of the agents; any other tool name, such as an MCP tool, is replaced. */
export const FIXTURE_TOOLS: ReadonlySet<string> = new Set([
  // Claude Code
  "Bash",
  "BashOutput",
  "KillShell",
  "Read",
  "Write",
  "Edit",
  "MultiEdit",
  "Glob",
  "Grep",
  "LS",
  "Task",
  "Agent",
  "TodoWrite",
  "WebFetch",
  "WebSearch",
  "NotebookRead",
  "NotebookEdit",
  "ExitPlanMode",
  "Skill",
  "ToolSearch",
  // Codex
  "exec",
  "exec_command",
  "write_stdin",
  "shell",
  "apply_patch",
  "update_plan",
  "view_image",
  "js",
  // Antigravity
  "read_file",
  "view_file",
  "write_file",
  "write_to_file",
  "edit_file",
  "replace_file_content",
  "multi_replace_file_content",
  "run_command",
  "command_status",
  "grep_search",
  "find_by_name",
  "list_dir",
  "search_web",
  "read_url_content",
  "manage_task",
  "send_message",
  "schedule",
  "invoke_subagent",
  "define_subagent",
  "manage_subagents",
  "ask_question",
]);
export const FIXTURE_TOOL = "tool";

const IDS = new Set([
  "uuid",
  "parentUuid",
  "logicalParentUuid",
  "sourceToolAssistantUUID",
  "id",
  "tool_use_id",
  "call_id",
  "message_id",
  "turn_id",
  "agentId",
  "promptId",
  "requestId",
  "requestRef",
]);
const SESSIONS = new Set(["sessionId", "session_id"]);
const TOOL_BLOCKS = new Set(["tool_use", "server_tool_use", "function_call", "custom_tool_call"]);
/** ID prefixes the agents themselves use; anything else before `_` could be a name. */
const ID_PREFIXES = /^(toolu|call|msg|req|resp|srvtoolu|fc|rs|ws)_/;
export const FIXTURE_ID =
  /^(?:[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-8[0-9a-f]{3}-[0-9a-f]{12}|(?:(?:toolu|call|msg|req|resp|srvtoolu|fc|rs|ws)_)?[0-9a-f]{24})$/;

/** A fresh key per run: stand-ins can't be reversed by hashing guesses. */
const KEY = randomBytes(32);
function stand(value: string): string {
  const hash = createHmac("sha256", KEY).update(value).digest("hex");
  if (/^[0-9a-f]{8}-[0-9a-f]{4}-/i.test(value))
    return `${hash.slice(0, 8)}-${hash.slice(8, 12)}-4${hash.slice(13, 16)}-8${hash.slice(17, 20)}-${hash.slice(20, 32)}`;
  return `${ID_PREFIXES.exec(value)?.[0] ?? ""}${hash.slice(0, 24)}`;
}

export function scrubJson(value: unknown, key = "", parentType?: unknown): unknown {
  if (Array.isArray(value)) return value.map((item) => scrubJson(item, key, parentType));
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return Object.fromEntries(
      Object.entries(record).map(([name, item], index) => [
        FIXTURE_KEYS.has(name) ? name : `key${index}`,
        name === "name" && TOOL_BLOCKS.has(String(record.type))
          ? typeof item === "string" && FIXTURE_TOOLS.has(item)
            ? item
            : FIXTURE_TOOL
          : scrubJson(item, FIXTURE_KEYS.has(name) ? name : "", record.type),
      ]),
    );
  }
  if (typeof value !== "string") return value;
  if (SESSIONS.has(key)) return FIXTURE_SESSION;
  if (IDS.has(key)) return stand(value);
  if (key === "timestamp") return FIXTURE_TIME;
  if (ENUM_FIELDS.has(key) && FIXTURE_VALUES.has(value)) return value;
  if (VERSION_FIELDS.has(key) && VERSION.test(value)) return value;
  return filler(value.length);
}

/** Whether a committed JSON fixture string is one the rules above could have produced. */
export function fixtureStringAllowed(value: string, key: string): boolean {
  return (
    isFiller(value) ||
    FIXTURE_ID.test(value) ||
    value === FIXTURE_SESSION ||
    value === FIXTURE_TIME ||
    (ENUM_FIELDS.has(key) && FIXTURE_VALUES.has(value)) ||
    (VERSION_FIELDS.has(key) && VERSION.test(value)) ||
    (key === "name" && (FIXTURE_TOOLS.has(value) || value === FIXTURE_TOOL))
  );
}
export function fixtureKeyAllowed(key: string): boolean {
  return FIXTURE_KEYS.has(key) || /^key\d+$/.test(key);
}

/**
 * Protobuf steps are scrubbed by path. Only the messages the Antigravity decoder reads are
 * entered; every other byte field is replaced whole, so text that happens to parse as protobuf
 * can't survive. Inside them, only tool names and argument names on the lists are kept.
 */
const CONTAINERS = new Set([
  "19",
  "20",
  "20.7",
  "24",
  "24.3",
  "31",
  "114",
  "114.2",
  "140",
  "140.1",
  "140.2",
]);
const TOOL_NAME_PATH = "20.7.2";
const ARGUMENT_KEY_PATH = "140.1.1";
export const FIXTURE_ARGUMENT_KEYS: ReadonlySet<string> = new Set([
  "toolSummary",
  "toolAction",
  "CommandLine",
  "Path",
  "Cwd",
  "Query",
  "Url",
  "SearchPath",
]);
const FILLER_BYTES = new TextEncoder().encode(PHRASE.repeat(8));

function varint(value: number): Uint8Array {
  const out: number[] = [];
  do {
    let byte = value % 128;
    value = Math.floor(value / 128);
    if (value) byte |= 0x80;
    out.push(byte);
  } while (value);
  return Uint8Array.from(out);
}
/** A kept leaf string at this path, or null when it must be replaced. */
function keptLeaf(path: string, bytes: Uint8Array): boolean {
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return false;
  }
  return (
    (path === TOOL_NAME_PATH && FIXTURE_TOOLS.has(text)) ||
    (path === ARGUMENT_KEY_PATH && FIXTURE_ARGUMENT_KEYS.has(text))
  );
}

export function scrubProtobuf(
  bytes: Uint8Array,
  fields: (
    bytes: Uint8Array,
    depth: number,
  ) =>
    | readonly ({ number: number } & (
        | { wire: 0; value: number }
        | { wire: 2; value: Uint8Array }
      ))[]
    | null,
  path = "",
): Uint8Array {
  const parsed = fields(bytes, path ? path.split(".").length : 0);
  if (!parsed) return FILLER_BYTES.subarray(0, Math.min(bytes.length, 200));
  const out: Uint8Array[] = [];
  for (const field of parsed) {
    const here = path ? `${path}.${field.number}` : String(field.number);
    out.push(varint(field.number * 8 + field.wire));
    if (field.wire === 0) {
      out.push(varint(field.value));
      continue;
    }
    const next = CONTAINERS.has(here)
      ? scrubProtobuf(field.value, fields, here)
      : keptLeaf(here, field.value)
        ? field.value
        : FILLER_BYTES.subarray(0, Math.min(field.value.length, 200));
    out.push(varint(next.length), next);
  }
  return Buffer.concat(out);
}
