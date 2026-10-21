import type { TranscriptAgent } from "./transcript-file.js";

/** Private native evidence. Never accept it from the phone or include it in hello/session lists. */
export interface AgentTranscriptReference {
  readonly agent: TranscriptAgent;
  readonly kind: "id" | "path";
  readonly value: string;
}
export interface ConversationReference extends AgentTranscriptReference {
  /** Opaque native lifetime/identity generation. Equality is meaningful only within this process. */
  readonly owner: string;
}

export function sameTranscriptReference(
  a: AgentTranscriptReference | null,
  b: AgentTranscriptReference | null,
): boolean {
  return a === b || (!!a && !!b && a.agent === b.agent && a.kind === b.kind && a.value === b.value);
}
