/**
 * Turn a real Antigravity CLI conversation database into an anonymised fixture:
 *
 *   pnpm --filter shellbell conversation:fixture:agy ~/.gemini/antigravity-cli/conversations/<id>.db 1.4.7
 *
 * Step types, statuses and the field structure the decoder reads survive; every other byte
 * field, and every string not listed in `fixture-scrub.ts`, is replaced. The fixture test
 * checks the result; still read it before committing.
 */
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { protobufFields } from "../src/conversation/antigravity.js";
import { scrubProtobuf } from "./fixture-scrub.js";

const [file, version] = process.argv.slice(2);
if (!file || !version || !/^\d{1,6}(?:\.\d{1,6}){0,3}$/.test(version)) {
  console.error("Usage: conversation:fixture:agy <conversation.db> <agy-version, such as 1.4.7>");
  process.exit(1);
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
  insert.run(
    row.idx,
    row.step_type,
    row.status,
    row.step_payload ? scrubProtobuf(row.step_payload, protobufFields) : null,
  );
target.close();
console.log(`Wrote ${rows.length} steps to ${out}`);
