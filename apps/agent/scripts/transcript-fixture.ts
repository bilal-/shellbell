/**
 * Turn a real agent transcript into an anonymised fixture for the transcript adapters:
 *
 *   pnpm --filter shellbell conversation:fixture claude ~/.claude/projects/<project>/<id>.jsonl
 *
 * Record shapes, types, tool names and versions survive. All text, commands, paths, IDs and
 * images are replaced, and only the newest records are kept. Read the output before committing.
 */
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const SESSION = "11111111-1111-4111-8111-111111111111";
/** Values kept as written: they name a shape, never content. */
const KEEP = new Set([
  "type",
  "subtype",
  "role",
  "channel",
  "phase",
  "history_mode",
  "kind",
  "version",
  "cli_version",
  "status",
  "stop_reason",
  "originator",
]);
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
const TOOLS = new Set(["tool_use", "server_tool_use", "function_call", "custom_tool_call"]);

const [agent, file, count = "800"] = process.argv.slice(2);
if ((agent !== "claude" && agent !== "codex") || !file) {
  console.error("Usage: conversation:fixture <claude|codex> <transcript.jsonl> [records]");
  process.exit(1);
}

/** The same ID always maps to the same stand-in, so parent links and tool pairs still join. */
function stand(value: string): string {
  const hash = createHash("sha256").update(value).digest("hex");
  if (/^[0-9a-f]{8}-[0-9a-f]{4}-/i.test(value))
    return `${hash.slice(0, 8)}-${hash.slice(8, 12)}-4${hash.slice(13, 16)}-8${hash.slice(17, 20)}-${hash.slice(20, 32)}`;
  const prefix = /^[a-z]+_/i.exec(value)?.[0] ?? "";
  return `${prefix}${hash.slice(0, 24)}`;
}

function text(value: string): string {
  // Keep a rough length, capped, so layout-relevant sizes stay plausible but small.
  const length = Math.min(Math.max(value.length, 1), 160);
  return (
    "lorem ipsum dolor sit amet "
      .repeat(Math.ceil(length / 27))
      .slice(0, length)
      .trimEnd() || "x"
  );
}

function scrub(value: unknown, key = ""): unknown {
  if (Array.isArray(value)) return value.map((item) => scrub(item, key));
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value).map(([name, item], index) => [
        // Some records use paths or other private text as keys.
        /^[A-Za-z_][A-Za-z0-9_]{0,63}$/.test(name) ? name : `key${index}`,
        // A tool's name says which tool ran; `name` elsewhere can be a file name.
        name === "name" && TOOLS.has(String((value as { type?: unknown }).type))
          ? item
          : scrub(item, name),
      ]),
    );
  if (typeof value !== "string") return value;
  if (SESSIONS.has(key)) return SESSION;
  if (IDS.has(key)) return stand(value);
  if (KEEP.has(key)) return value;
  if (key === "timestamp") return "2026-01-01T00:00:00.000Z";
  return text(value);
}

const lines = readFileSync(file, "utf8").split("\n").filter(Boolean);
// Codex identity comes from its first record, so it always stays.
const kept =
  agent === "codex"
    ? [lines[0]!, ...lines.slice(1).slice(-Number(count))]
    : lines.slice(-Number(count));
const records = kept.map((line) => {
  const value = scrub(JSON.parse(line)) as Record<string, unknown>;
  if (agent === "codex" && value.type === "session_meta") {
    const payload = value.payload as Record<string, unknown>;
    payload.id = SESSION;
  }
  return JSON.stringify(value);
});
const version =
  agent === "claude"
    ? (JSON.parse(lines.at(-1)!).version ??
      [...lines]
        .reverse()
        .map((line) => JSON.parse(line).version)
        .find(Boolean))
    : JSON.parse(lines[0]!).payload?.cli_version;
const out = join(import.meta.dirname, "../test/fixtures/transcripts", `${agent}-${version}.jsonl`);
writeFileSync(out, `${records.join("\n")}\n`);
console.log(`Wrote ${records.length} records to ${out}`);
