import type { TranscriptAgent } from "./transcript-file.js";

/**
 * The agent versions each transcript adapter has been checked against, with a fixture per
 * version in `test/fixtures/transcripts`. To support a new agent release: add its fixture with
 * `pnpm --filter shellbell conversation:fixture`, fix whatever it shows as unsupported, then
 * raise `through` here. Older versions inside the range keep their fixtures.
 */
export const TRANSCRIPT_FORMATS = {
  claude: { name: "Claude Code", from: "2.1.286", through: "2.1.310" },
  codex: { name: "Codex", from: "0.164.0", through: "0.166.0" },
  // Gemini's records don't say which version wrote them, so this range is checked by its
  // fixture only, never against a running Gemini.
  gemini: { name: "Gemini CLI", from: "0.62.0", through: "0.62.0" },
} as const satisfies Record<
  "claude" | "codex" | "gemini",
  { name: string; from: string; through: string }
>;

const VERSION = /^\d{1,6}(?:\.\d{1,6}){0,3}$/;

/** A plain dotted version, or null for anything else an agent writes. */
export function transcriptVersion(value: unknown): string | null {
  return typeof value === "string" && VERSION.test(value) ? value : null;
}

function compare(a: string, b: string): number {
  const left = a.split(".").map(Number);
  const right = b.split(".").map(Number);
  for (let i = 0; i < Math.max(left.length, right.length); i++) {
    const difference = (left[i] ?? 0) - (right[i] ?? 0);
    if (difference) return Math.sign(difference);
  }
  return 0;
}

export type TranscriptFormatStatus = "tested" | "newer" | "older";

export function transcriptFormatStatus(
  agent: TranscriptAgent,
  version: string,
): TranscriptFormatStatus {
  // Agents without a declared range, such as Antigravity's databases, are not version-checked.
  if (!Object.hasOwn(TRANSCRIPT_FORMATS, agent)) return "tested";
  const format = TRANSCRIPT_FORMATS[agent as keyof typeof TRANSCRIPT_FORMATS];
  if (compare(version, format.through) > 0) return "newer";
  if (compare(version, format.from) < 0) return "older";
  return "tested";
}

/** Agent versions already logged in this process; a handful at most, but bounded anyway. */
const reported = new Set<string>();
const REPORTED_VERSIONS = 64;

/**
 * Logs, once per agent and version in this process, a version newer than the adapter has been
 * checked against. This is for maintainers only: a version number alone never shows anything in
 * a conversation, since records that can't be read are already marked where they occur.
 */
export function reportTranscriptVersion(
  agent: TranscriptAgent,
  version: string,
  log: (message: string, fields: Record<string, unknown>) => void,
): void {
  if (transcriptFormatStatus(agent, version) !== "newer") return;
  const key = `${agent}@${version}`;
  if (reported.has(key) || reported.size >= REPORTED_VERSIONS) return;
  reported.add(key);
  log("agent-version-newer-than-tested", {
    agent,
    version,
    tested: TRANSCRIPT_FORMATS[agent as keyof typeof TRANSCRIPT_FORMATS].through,
  });
}
