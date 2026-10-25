/**
 * Turn a real agent transcript into an anonymised fixture for the transcript adapters:
 *
 *   pnpm --filter shellbell conversation:fixture claude ~/.claude/projects/<project>/<id>.jsonl
 *
 * Only the newest records are kept, and every string is replaced unless `fixture-scrub.ts`
 * lists it. The fixture test checks the result; still read it before committing.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { FIXTURE_SESSION, scrubJson } from "./fixture-scrub.js";

const [agent, file, count = "800"] = process.argv.slice(2);
if ((agent !== "claude" && agent !== "codex") || !file) {
  console.error("Usage: conversation:fixture <claude|codex> <transcript.jsonl> [records]");
  process.exit(1);
}

const lines = readFileSync(file, "utf8").split("\n").filter(Boolean);
// Codex identity comes from its first record, so it always stays.
const kept =
  agent === "codex"
    ? [lines[0]!, ...lines.slice(1).slice(-Number(count))]
    : lines.slice(-Number(count));
const records = kept.map((line) => {
  const value = scrubJson(JSON.parse(line)) as Record<string, unknown>;
  if (agent === "codex" && value.type === "session_meta") {
    const payload = value.payload as Record<string, unknown>;
    payload.id = FIXTURE_SESSION;
  }
  return JSON.stringify(value);
});
const version =
  agent === "claude"
    ? [...lines]
        .reverse()
        .map((line) => JSON.parse(line).version)
        .find(Boolean)
    : JSON.parse(lines[0]!).payload?.cli_version;
if (typeof version !== "string" || !/^\d{1,6}(?:\.\d{1,6}){0,3}$/.test(version)) {
  console.error("The transcript names no plain version, so the fixture can't be named.");
  process.exit(1);
}
const out = join(import.meta.dirname, "../test/fixtures/transcripts", `${agent}-${version}.jsonl`);
writeFileSync(out, `${records.join("\n")}\n`);
console.log(`Wrote ${records.length} records to ${out}`);
