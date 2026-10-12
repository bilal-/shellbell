import { NotificationBoxSchema, NotificationFeaturesSchema } from "@shellbell/protocol";
import { identityTimestamp } from "../ports/models.js";
import type { Job, JobState } from "./models.js";

/** Existing persisted phases, including legacy receipt rows retained for recovery. */
export const notificationJobStates = Object.freeze({
  send: "pending-send",
  sending: "sending",
  receipt: "pending-receipt",
  checking: "checking-receipt",
} as const);
const phases: Record<JobState, string> = {
  "pending-send": "send",
  sending: "sending",
  "pending-receipt": "receipt",
  "checking-receipt": "checking",
};
export function notificationJobPhase(state: JobState): string {
  return phases[state];
}

/** Strict decoding; each repository explicitly chooses its legacy fallback policy. */
export function decodeNotificationContext(json: string | null): Job["context"] {
  return json === null ? null : NotificationBoxSchema.parse(JSON.parse(json));
}
export function decodeNotificationFeatures(json: string): string[] {
  return NotificationFeaturesSchema.parse(JSON.parse(json));
}

function text(value: unknown): string {
  if (typeof value !== "string") throw new Error("Invalid stored notification text");
  return value;
}
function nullableText(value: unknown): string | null {
  return value === null ? null : text(value);
}
function nullableTime(value: unknown): number | null {
  return value === null ? null : identityTimestamp(value);
}

/**
 * Decodes one stored `push_jobs` row, rejecting values the schema does not constrain. With
 * `contextFallback`, unreadable stored context becomes null (a generic message) instead of an
 * error, for repositories that retain rows from before context validation.
 */
export function decodeNotificationJob(
  row: Readonly<Record<string, unknown>>,
  options: { contextFallback?: boolean } = {},
): Job {
  const phase = text(row.phase);
  if (!Object.hasOwn(notificationJobStates, phase))
    throw new Error("Invalid stored notification phase");
  const kind = nullableText(row.kind);
  if (kind !== null && !["prompt", "idle", "blocked"].includes(kind))
    throw new Error("Invalid stored notification kind");
  const exitCode = row.exit_code;
  if (exitCode !== null && (typeof exitCode !== "number" || !Number.isSafeInteger(exitCode)))
    throw new Error("Invalid stored exit code");
  let context: Job["context"] = null;
  if (row.context_json !== null) {
    try {
      context = decodeNotificationContext(text(row.context_json));
    } catch (error) {
      if (!options.contextFallback) throw error;
    }
  }
  return {
    id: text(row.id),
    phoneFp: text(row.phone_fp),
    generation: text(row.generation),
    state: notificationJobStates[phase as keyof typeof notificationJobStates],
    admittedAt: identityTimestamp(row.admitted_at),
    expiresAt: identityTimestamp(row.expires_at),
    dueAt: identityTimestamp(row.due_at),
    sendCount: identityTimestamp(row.send_count),
    checkCount: identityTimestamp(row.check_count),
    claimId: nullableText(row.claim_id),
    claimUntil: nullableTime(row.claim_until),
    sessionId: nullableText(row.session_id),
    kind: kind as Job["kind"],
    exitCode,
    durationMs: nullableTime(row.duration_ms),
    ticketId: nullableText(row.ticket_id),
    acceptedAt: nullableTime(row.accepted_at),
    context,
  };
}

/** Common job columns in SQL binding order. Scope and row ID remain adapter-owned. */
export function notificationJobFields(job: Job): readonly (string | number | null)[] {
  return [
    job.phoneFp,
    job.generation,
    notificationJobPhase(job.state),
    job.admittedAt,
    job.expiresAt,
    job.dueAt,
    job.sendCount,
    job.checkCount,
    job.claimId,
    job.claimUntil,
    job.sessionId,
    job.kind,
    job.exitCode,
    job.durationMs,
    job.ticketId,
    job.acceptedAt,
    job.context ? JSON.stringify(job.context) : null,
  ];
}
