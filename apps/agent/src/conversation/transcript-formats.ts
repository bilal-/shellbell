import type { TranscriptAgent } from "./transcript-file.js";

/**
 * The agent versions each transcript adapter has been checked against, with a fixture per
 * version in `test/fixtures/transcripts`. To support a new agent release: add its fixture with
 * `pnpm --filter shellbell conversation:fixture`, fix whatever it shows as unsupported, then
 * raise `through` here. Older versions inside the range keep their fixtures.
 */
export const TRANSCRIPT_FORMATS = {
  claude: { name: "Claude Code", from: "2.1.286", through: "2.1.309" },
  codex: { name: "Codex", from: "0.164.0", through: "0.164.0" },
} as const satisfies Record<"claude" | "codex", { name: string; from: string; through: string }>;

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
  const format = TRANSCRIPT_FORMATS[agent as "claude" | "codex"];
  if (compare(version, format.through) > 0) return "newer";
  if (compare(version, format.from) < 0) return "older";
  return "tested";
}

/** One quiet line for a version this computer hasn't been checked against, or null. */
export function transcriptFormatNotice(agent: TranscriptAgent, version: string): string | null {
  const status = transcriptFormatStatus(agent, version);
  if (status === "tested") return null;
  const name = TRANSCRIPT_FORMATS[agent as "claude" | "codex"].name;
  return status === "newer"
    ? `${name} ${version} is newer than this computer has been checked with. Update Shellbell on your computer if parts of this conversation are missing.`
    : `${name} ${version} is older than this computer has been checked with. Some parts of this conversation may be missing.`;
}
