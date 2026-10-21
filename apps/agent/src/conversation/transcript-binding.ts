import { type ConversationReference, sameTranscriptReference } from "./reference.js";
import type { TranscriptIdentity } from "./transcript-file.js";
import type { TranscriptLocator } from "./transcript-locator.js";

export interface TranscriptIdentityProbeOptions {
  enabled: () => boolean;
  /** Fresh native proof for exactly one registry-scoped pane. Must honor cancellation. */
  reference: (signal: AbortSignal) => Promise<ConversationReference | null>;
  /** Shared across consumers, including retries; never constructed per probe. */
  locator: Pick<TranscriptLocator, "locate">;
}

/**
 * Connects native ownership to an exact file candidate. Use as TranscriptFile's identity port;
 * that reader supplies its lifetime and proof deadline. Any other caller must do the same.
 * This does not verify transcript record metadata or authorize queued data delivery by itself.
 * Each invocation resolves again: a second Codex rollout can appear with the same native ID.
 */
export function createTranscriptIdentityProbe(
  options: TranscriptIdentityProbeOptions,
): (signal: AbortSignal) => Promise<TranscriptIdentity | null> {
  return async (signal) => {
    const available = () => !signal.aborted && options.enabled();
    try {
      if (!available()) return null;
      const sampled = await options.reference(signal);
      if (
        !available() ||
        !sampled ||
        typeof sampled.owner !== "string" ||
        !sampled.owner ||
        sampled.owner.length > 1024
      )
        return null;
      // A later mutation of an adapter-owned object must not rewrite the captured evidence.
      const before = Object.freeze({ ...sampled });
      const located = await options.locator.locate(before, signal);
      if (!available() || located.status !== "candidate") return null;
      const candidate = Object.freeze({
        agent: located.candidate.agent,
        path: located.candidate.path,
        session: located.candidate.session,
      });
      if (
        candidate.agent !== before.agent ||
        (before.kind === "path"
          ? candidate.path !== before.value
          : candidate.session !== before.value.toLowerCase())
      )
        return null;
      const after = await options.reference(signal);
      if (!available() || !sameTranscriptReference(before, after) || before.owner !== after?.owner)
        return null;
      return Object.freeze({ ...candidate, owner: before.owner });
    } catch {
      // Filesystem/native errors can contain transcript paths or private process details.
      return null;
    }
  };
}
