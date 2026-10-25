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

/**
 * Where a JSON value sits. Inside free content (tool inputs and results, arguments, and any key
 * no decoder reads) nothing is structural: every string is replaced, whatever it looks like.
 */
interface JsonPlace {
  readonly key: string;
  readonly free: boolean;
  readonly toolBlock: boolean;
}
/** Content an agent or the owner wrote, which never carries a record's kind or IDs. */
const FREE_KEYS = new Set(["input", "arguments", "toolUseResult", "output"]);

/** What a string at this place may stay as, or null when it must be replaced. */
function keepString(value: string, place: JsonPlace): string | null {
  if (place.free) return null;
  if (SESSIONS.has(place.key)) return FIXTURE_SESSION;
  if (place.key === "timestamp") return FIXTURE_TIME;
  if (ENUM_FIELDS.has(place.key) && FIXTURE_VALUES.has(value)) return value;
  if (VERSION_FIELDS.has(place.key) && VERSION.test(value)) return value;
  if (place.key === "name" && place.toolBlock)
    return FIXTURE_TOOLS.has(value) ? value : FIXTURE_TOOL;
  return null;
}
function childPlace(name: string, parent: JsonPlace, record: Record<string, unknown>): JsonPlace {
  const known = FIXTURE_KEYS.has(name);
  return {
    key: known ? name : "",
    free: parent.free || !known || FREE_KEYS.has(name),
    toolBlock: !parent.free && TOOL_BLOCKS.has(String(record.type)),
  };
}
const ROOT: JsonPlace = { key: "", free: false, toolBlock: false };

export function scrubJson(value: unknown, place: JsonPlace = ROOT): unknown {
  if (Array.isArray(value)) return value.map((item) => scrubJson(item, place));
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return Object.fromEntries(
      Object.entries(record).map(([name, item], index) => [
        FIXTURE_KEYS.has(name) ? name : `key${index}`,
        scrubJson(item, childPlace(name, place, record)),
      ]),
    );
  }
  if (typeof value !== "string") return value;
  if (!place.free && IDS.has(place.key)) return stand(value);
  return keepString(value, place) ?? filler(value.length);
}

/** Every problem in a committed JSON fixture value, judged by the same places as scrubJson. */
export function jsonFixtureProblems(value: unknown, place: JsonPlace = ROOT): string[] {
  if (Array.isArray(value)) return value.flatMap((item) => jsonFixtureProblems(item, place));
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return Object.entries(record).flatMap(([name, item]) => [
      ...(FIXTURE_KEYS.has(name) || /^key\d+$/.test(name) ? [] : [`key ${name}`]),
      ...jsonFixtureProblems(item, childPlace(name, place, record)),
    ]);
  }
  if (typeof value !== "string") return [];
  const ok =
    isFiller(value) ||
    (!place.free && IDS.has(place.key) && FIXTURE_ID.test(value)) ||
    keepString(value, place) === value;
  return ok ? [] : [`${place.key || "?"}: ${value.slice(0, 40)}`];
}

/**
 * Protobuf steps are scrubbed by path. Only the fields the Antigravity decoder reads are kept;
 * every other field, number or bytes, is dropped, so text that happens to parse as protobuf
 * can't survive. Text fields keep only listed tool and argument names.
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
const TEXT_PATHS = new Set([
  "19.2",
  "20.1",
  "20.7.2",
  "24.3.2",
  "31.2",
  "114.2.1",
  "140.1.1",
  "140.1.2",
  "140.2.1",
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
type Fields = (
  bytes: Uint8Array,
  depth: number,
) =>
  | readonly ({ number: number } & ({ wire: 0; value: number } | { wire: 2; value: Uint8Array }))[]
  | null;

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
function listedText(path: string, bytes: Uint8Array): boolean {
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

export function scrubProtobuf(bytes: Uint8Array, fields: Fields, path = ""): Uint8Array {
  const parsed = fields(bytes, path ? path.split(".").length : 0) ?? [];
  const out: Uint8Array[] = [];
  for (const field of parsed) {
    const here = path ? `${path}.${field.number}` : String(field.number);
    if (field.wire !== 2 || !(CONTAINERS.has(here) || TEXT_PATHS.has(here))) continue;
    const next = CONTAINERS.has(here)
      ? scrubProtobuf(field.value, fields, here)
      : listedText(here, field.value)
        ? field.value
        : FILLER_BYTES.subarray(0, Math.min(Math.max(field.value.length, 1), 200));
    out.push(varint(field.number * 8 + 2), varint(next.length), next);
  }
  return Buffer.concat(out);
}

/** Every problem in a committed protobuf step: unlisted fields, or text that isn't filler. */
export function protobufFixtureProblems(bytes: Uint8Array, fields: Fields, path = ""): string[] {
  const parsed = fields(bytes, path ? path.split(".").length : 0);
  if (!parsed) return [`${path || "root"}: not a message`];
  const decoder = new TextDecoder();
  return parsed.flatMap((field) => {
    const here = path ? `${path}.${field.number}` : String(field.number);
    if (field.wire !== 2) return [`${here}: number field`];
    if (CONTAINERS.has(here)) return protobufFixtureProblems(field.value, fields, here);
    if (!TEXT_PATHS.has(here)) return [`${here}: unlisted field`];
    const text = decoder.decode(field.value);
    return listedText(here, field.value) || PHRASE.repeat(8).startsWith(text)
      ? []
      : [`${here}: ${text.slice(0, 40)}`];
  });
}
