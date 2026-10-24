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

const [file, version = "unknown"] = process.argv.slice(2);
if (!file) {
  console.error("Usage: conversation:fixture:agy <conversation.db> [agy-version]");
  process.exit(1);
}
const FILLER = new TextEncoder().encode("lorem ipsum dolor sit amet ".repeat(400));
/** Tool names are kept so call rows still read like the agent's own; they hold no content. */
const KEEP = /^[a-z][a-z0-9_]{1,40}$/;
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
  const out: number[] = [];
  for (const field of fields) {
    out.push(...varint(field.number * 8 + field.wire));
    if (field.wire === 0) {
      out.push(...varint(field.value));
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
      printable && (KEEP.test(text!) || KEYS.has(text!))
        ? value
        : nested && nested.length && !(printable && text!.includes(" "))
          ? scrub(value, depth + 1)
          : FILLER.subarray(0, Math.min(value.length, 200));
    out.push(...varint(next.length), ...next);
  }
  return Uint8Array.from(out);
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
