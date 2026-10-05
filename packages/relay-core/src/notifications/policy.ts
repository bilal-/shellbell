import type { NotificationBox } from "@shellbell/protocol";
import { identityTimestamp } from "../ports/models.js";
import type { Claim, Job, NotifyMessage, Registration } from "./models.js";
import type { SendOutcome } from "./provider.js";

export const notificationLimits = Object.freeze({
  lifetimeMs: 3_600_000,
  freshnessMs: 120_000,
  claimMs: 10_000,
  attempts: 3,
  budgetWindowMs: 3_600_000,
  budgetAttempts: 20,
  ringMs: 60_000,
  ringRows: 200,
  jobs: 200,
  phoneJobs: 20,
});
export function ringAllowed(last: number | null, now: number): boolean {
  return last === null || now - last >= notificationLimits.ringMs;
}
export function capacityAvailable(total: number, phone: number): boolean {
  return total < notificationLimits.jobs && phone < notificationLimits.phoneJobs;
}
export function budgetCutoff(now: number): number {
  return now - notificationLimits.budgetWindowMs;
}
export function budgetAvailable(attempts: number, legacy: number): boolean {
  return attempts + legacy < notificationLimits.budgetAttempts;
}

/** Validate all stored usage before adapters prune expired rows or reserve an attempt. */
export function legacyBudgetUsage(
  legacy: { count: unknown; windowStart: unknown } | undefined,
  attemptTimes: Iterable<unknown>,
  now: number,
): number {
  let active = 0;
  if (legacy) {
    const count = identityTimestamp(legacy.count);
    const windowStart = identityTimestamp(legacy.windowStart);
    if (windowStart > budgetCutoff(now)) active = count;
  }
  // Even expired corrupt rows must fail closed, not disappear during cleanup.
  for (const attemptedAt of attemptTimes) identityTimestamp(attemptedAt);
  return active;
}
export function newJob(
  id: string,
  phoneFp: string,
  generation: string,
  message: NotifyMessage,
  now: number,
  context: NotificationBox | undefined,
): Job {
  return {
    id,
    phoneFp,
    generation,
    state: "pending-send",
    admittedAt: now,
    expiresAt: now + notificationLimits.lifetimeMs,
    dueAt: now,
    sendCount: 0,
    checkCount: 0,
    claimId: null,
    claimUntil: null,
    sessionId: message.sessionId,
    kind: message.kind,
    exitCode: message.exitCode ?? null,
    durationMs: message.durationMs ?? null,
    ticketId: null,
    acceptedAt: null,
    context: context ?? null,
  };
}
function sendState(job: Job): boolean {
  return job.state === "pending-send" || job.state === "sending";
}
export function eligible(
  job: Job,
  registration: Registration | undefined,
  attentive: boolean,
  now: number,
): boolean {
  return (
    !!registration?.token &&
    ((registration.provider === "fcm" &&
      registration.platform === "android" &&
      registration.environment === null) ||
      (registration.provider === "apns" &&
        registration.platform === "ios" &&
        (registration.environment === "development" ||
          registration.environment === "production"))) &&
    registration.enabled &&
    registration.generation === job.generation &&
    !attentive &&
    now < job.expiresAt
  );
}
function fresh(job: Job, now: number): boolean {
  return !sendState(job) || now < job.admittedAt + notificationLimits.freshnessMs;
}
function backoff(count: number): number {
  return count === 1 ? 5000 : 30_000;
}
/** null removes work; otherwise return its complete next snapshot, without mutation. */
export function recoverJob(
  job: Job,
  registration: Registration | undefined,
  attentive: boolean,
  now: number,
): Job | null {
  if (!sendState(job) || !eligible(job, registration, attentive, now) || !fresh(job, now))
    return null;
  if (job.claimUntil !== null && job.claimUntil <= now) {
    const dueAt = now + backoff(job.sendCount);
    if (
      job.sendCount >= notificationLimits.attempts ||
      dueAt >= Math.min(job.expiresAt, job.admittedAt + notificationLimits.freshnessMs)
    )
      return null;
    return {
      ...job,
      state: "pending-send",
      claimId: null,
      claimUntil: null,
      dueAt,
    };
  }
  return job;
}
export function claimJob(job: Job, claimId: string, now: number): Job | null {
  if (
    job.state !== "pending-send" ||
    job.dueAt > now ||
    job.sendCount >= notificationLimits.attempts ||
    !fresh(job, now) ||
    now >= job.expiresAt
  )
    return null;
  return {
    ...job,
    state: "sending",
    claimId,
    claimUntil: now + notificationLimits.claimMs,
    sendCount: job.sendCount + 1,
    checkCount: job.checkCount,
  };
}
export function ownsClaim(
  claim: Claim,
  current: Job | undefined,
  registration: Registration | undefined,
  attentive: boolean,
  now: number,
): boolean {
  return (
    !!current &&
    current.id === claim.job.id &&
    current.claimId !== null &&
    current.claimId === claim.job.claimId &&
    current.generation === claim.job.generation &&
    current.state === claim.job.state &&
    (current.claimUntil ?? 0) > now &&
    eligible(current, registration, attentive, now) &&
    registration?.token === claim.token
  );
}
export function dispatchable(
  claim: Claim,
  current: Job | undefined,
  registration: Registration | undefined,
  attentive: boolean,
  now: number,
): boolean {
  return ownsClaim(claim, current, registration, attentive, now) && fresh(claim.job, now);
}
export type Completion = Readonly<{ job: Job | null; disableRegistration: boolean }>;
export function sendCompleted(job: Job, outcome: SendOutcome, now: number): Completion {
  if (outcome.status === "accepted") return { job: null, disableRegistration: false };
  const delay = outcome.status === "retryable" ? (outcome.retryAfterMs ?? 0) : 0;
  const dueAt = now + Math.max(backoff(job.sendCount), delay);

  if (
    outcome.status === "retryable" &&
    job.sendCount < notificationLimits.attempts &&
    dueAt < Math.min(job.expiresAt, job.admittedAt + notificationLimits.freshnessMs)
  ) {
    return {
      disableRegistration: false,
      job: { ...job, state: "pending-send", dueAt, claimId: null, claimUntil: null },
    };
  }
  return { job: null, disableRegistration: outcome.status === "unregistered" };
}
export function notificationDeadline(jobs: readonly Job[]): number | null {
  return jobs.length === 0
    ? null
    : Math.min(
        ...jobs.map((job) =>
          Math.min(
            job.expiresAt,
            job.claimUntil ?? job.dueAt,
            job.state === "pending-send"
              ? job.admittedAt + notificationLimits.freshnessMs
              : Number.POSITIVE_INFINITY,
          ),
        ),
      );
}
