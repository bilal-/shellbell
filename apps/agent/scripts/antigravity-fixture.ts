/**
 * Turn a real Antigravity CLI conversation database into an anonymised fixture:
 *
 *   pnpm --filter shellbell conversation:fixture:agy ~/.gemini/antigravity-cli/conversations/<id>.db
 *
 * Step types, statuses and protobuf field numbers survive. Every string, including tool
 * arguments and output, is replaced with filler of a similar length, so field shapes and
 * lengths stay realistic without any content. Read the output before committing.
 */

import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { protobufFields } from "../src/conversation/antigravity.js";

const [file, version] = process.argv.slice(2);
if (!file || !version || !/^\d{1,6}(?:\.\d{1,6}){0,3}$/.test(version)) {
  console.error("Usage: conversation:fixture:agy <conversation.db> <agy-version, such as 1.4.7>");
  process.exit(1);
}
const FILLER = new TextEncoder().encode("lorem ipsum dolor sit amet ".repeat(400));
/** Antigravity's own tool names, kept so call rows still read like the agent's; nothing else is. */
const TOOL_NAMES = new Set([
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
/** Argument names Antigravity uses; values next to them are scrubbed like everything else. */
const KEYS = new Set(["toolSummary", "toolAction", "CommandLine", "Path", "Cwd", "Query", "Url"]);

function varint(value: number): number[] {
  const out: number[] = [];
  do {
    let byte = value % 128;
    value = Math.floor(value / 128);
    if (value) byte |= 0x80;
    out.push(byte);
  } while (value);
  return out;
}
function scrub(bytes: Uint8Array, depth = 0): Uint8Array {
  const fields = protobufFields(bytes, depth);
  if (!fields) return FILLER.subarray(0, Math.min(bytes.length, FILLER.length));
  // Chunks joined once at the end: spreading large arrays into one would overflow the stack.
  const out: Uint8Array[] = [];
  for (const field of fields) {
    out.push(Uint8Array.from(varint(field.number * 8 + field.wire)));
    if (field.wire === 0) {
      out.push(Uint8Array.from(varint(field.value)));
      continue;
    }
    const value = field.value;
    let text: string | null = null;
    try {
      text = new TextDecoder("utf-8", { fatal: true }).decode(value);
    } catch {}
    const nested = protobufFields(value, depth + 1);
    const printable = text !== null && /^[\p{L}\p{N}\p{P}\p{S}\s]*$/u.test(text);
    const next =
      printable && (TOOL_NAMES.has(text!) || KEYS.has(text!))
        ? value
        : nested?.length && !(printable && text!.includes(" "))
          ? scrub(value, depth + 1)
          : FILLER.subarray(0, Math.min(value.length, 200));
    out.push(Uint8Array.from(varint(next.length)), next);
  }
  return Buffer.concat(out);
}

const source = new DatabaseSync(file, { readOnly: true });
const rows = source
  .prepare("SELECT idx, step_type, status, step_payload FROM steps ORDER BY idx")
  .all() as { idx: number; step_type: number; status: number; step_payload: Uint8Array | null }[];
source.close();
const out = join(import.meta.dirname, "../test/fixtures/transcripts", `agy-${version}.db`);
const target = new DatabaseSync(out);
target.exec("DROP TABLE IF EXISTS steps");
target.exec(
  "CREATE TABLE steps (idx INTEGER PRIMARY KEY, step_type INTEGER NOT NULL DEFAULT 0, status INTEGER NOT NULL DEFAULT 0, step_payload BLOB)",
);
const insert = target.prepare("INSERT INTO steps VALUES (?, ?, ?, ?)");
for (const row of rows)
  insert.run(row.idx, row.step_type, row.status, row.step_payload ? scrub(row.step_payload) : null);
target.close();
console.log(`Wrote ${rows.length} steps to ${out}`);
