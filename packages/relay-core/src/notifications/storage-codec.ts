import { NotificationBoxSchema, NotificationFeaturesSchema } from "@shellbell/protocol";
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
