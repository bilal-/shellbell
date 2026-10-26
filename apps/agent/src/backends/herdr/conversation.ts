import { isAbsolute, normalize } from "node:path";
import { type CodexSessions, codexSessions } from "../../conversation/codex-sessions.js";
import type { AgentTranscriptReference } from "../../conversation/reference.js";

/** Only the known Herdr integrations' explicit reports qualify. Display labels are not identity. */
export function herdrTranscriptReference(value: unknown): AgentTranscriptReference | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const info = value as Record<string, unknown>;
  // Herdr names Antigravity CLI `agy`, reported by its `antigravity_cli` integration.
  const source = info.agent === "agy" ? "herdr:antigravity_cli" : `herdr:${info.agent}`;
  if (info.agent !== "claude" && info.agent !== "codex" && info.agent !== "agy") return null;
  if (info.source !== source || typeof info.value !== "string") return null;
  if (info.agent === "agy" && info.kind !== "id") return null;
  if (info.kind === "id" && /^[a-zA-Z0-9][a-zA-Z0-9_.:-]{0,255}$/.test(info.value))
    return Object.freeze({ agent: info.agent, kind: "id", value: info.value });
  if (
    info.kind === "path" &&
    info.value.length <= 4096 &&
    isAbsolute(info.value) &&
    normalize(info.value) === info.value &&
    info.value.endsWith(".jsonl") &&
    !Array.from(info.value).some(
      (c) =>
        c.charCodeAt(0) < 32 ||
        (c.charCodeAt(0) >= 127 && c.charCodeAt(0) <= 159) ||
        (c.length === 1 && c.charCodeAt(0) >= 0xd800 && c.charCodeAt(0) <= 0xdfff),
    )
  )
    return Object.freeze({ agent: info.agent, kind: "path", value: info.value });
  return null;
}

/**
 * A pane's proof: Herdr's own report, or for Codex without one, the session Shellbell's opt-in
 * Codex hook last recorded for this Herdr pane (`codex-sessions.ts`).
 */
export function herdrPaneReference(
  info: { agent?: unknown; agent_session?: unknown; pane_id?: unknown } | undefined,
  sessions: CodexSessions = codexSessions(),
): AgentTranscriptReference | null {
  const reported = herdrTranscriptReference(info?.agent_session);
  if (reported || info?.agent !== "codex" || typeof info.pane_id !== "string") return reported;
  const record = sessions.find({ herdr: info.pane_id });
  return record ? Object.freeze({ agent: "codex", kind: "id", value: record.session }) : null;
}
