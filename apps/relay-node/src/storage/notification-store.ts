import type { SQLOutputValue } from "node:sqlite";
import {
  budgetAvailable,
  budgetCutoff,
  type Claim,
  type Completion,
  capacityAvailable,
  claimJob,
  decodeNotificationContext,
  decodeNotificationFeatures,
  dispatchable,
  eligible,
  identityTimestamp,
  type Job,
  legacyBudgetUsage,
  type NotificationStore,
  newJob,
  notificationDeadline,
  notificationJobFields,
  notificationJobPhase,
  notificationJobStates,
  notificationLimits,
  ownsClaim,
  type Registration,
  recoverJob,
  ringAllowed,
  selectPushContext,
  sendCompleted,
} from "@shellbell/relay-core";
import type { NodeDatabase } from "./database.js";
import { validatePushRegistration } from "./input-validation.js";

type Row = Record<string, SQLOutputValue>;
function text(value: SQLOutputValue | undefined): string {
  if (typeof value !== "string") throw new Error("Invalid stored notification text");
  return value;
}
function nullableText(value: SQLOutputValue | undefined): string | null {
  return value === null ? null : text(value);
}
function nullableTime(value: SQLOutputValue | undefined): number | null {
  return value === null ? null : identityTimestamp(value);
}
function job(row: Row): Job {
  const phase = text(row.phase);
  if (!(phase in notificationJobStates)) throw new Error("Invalid stored notification phase");
  const kind = nullableText(row.kind);
  if (kind !== null && !["prompt", "idle", "blocked"].includes(kind))
    throw new Error("Invalid stored notification kind");
  const exitCode = row.exit_code;
  if (exitCode !== null && (typeof exitCode !== "number" || !Number.isSafeInteger(exitCode)))
    throw new Error("Invalid stored exit code");
  let context: Job["context"] = null;
  if (row.context_json !== null) context = decodeNotificationContext(text(row.context_json));
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
interface Options {
  computerFp: string;
  attentive(phone: string, now: number): boolean;
  randomId(): string;
}

/** SQL persists snapshots; admission, retry, budgets, fencing and deadlines stay in core policy. */
export function createNodeNotificationStore(
  context: NodeDatabase,
  options: Options,
): NotificationStore {
  const { db, transaction, assertOpen } = context;
  const fp = options.computerFp;
  const remove = (id: string) => {
    db.prepare("DELETE FROM push_jobs WHERE computer_fp = ? AND id = ?").run(fp, id);
  };
  const cancel = (phone: string) => {
    db.prepare("DELETE FROM push_jobs WHERE computer_fp = ? AND phone_fp = ?").run(fp, phone);
    db.prepare("DELETE FROM push_accepted WHERE computer_fp = ? AND phone_fp = ?").run(fp, phone);
  };
  const rows = () => db.prepare("SELECT * FROM push_jobs WHERE computer_fp = ?").all(fp).map(job);
  const registration = (phone: string): Registration | undefined => {
    const row = db
      .prepare(`SELECT r.generation, r.features, p.push_token, p.push_enabled, p.push_platform, p.push_provider, p.push_environment
      FROM push_registrations r JOIN pairings p ON p.computer_fp = r.computer_fp AND p.phone_fp = r.phone_fp
      WHERE r.computer_fp = ? AND r.phone_fp = ?`)
      .get(fp, phone);
    if (!row) return undefined;
    if (row.push_enabled !== 0 && row.push_enabled !== 1)
      throw new Error("Invalid stored notification setting");
    return {
      generation: text(row.generation),
      token: nullableText(row.push_token),
      enabled: row.push_enabled === 1,
      platform: nullableText(row.push_platform),
      provider: row.push_provider as Registration["provider"],
      environment: row.push_environment as Registration["environment"],
      features: decodeNotificationFeatures(row.features === null ? "[]" : text(row.features)),
    };
  };
  const write = (value: Job, insert = false) => {
    const values = [...notificationJobFields(value), fp, value.id];
    if (insert)
      db.prepare(`INSERT INTO push_jobs (phone_fp, generation, phase, admitted_at, expires_at, due_at, send_count, check_count,
      claim_id, claim_until, session_id, kind, exit_code, duration_ms, ticket_id, accepted_at, context_json, computer_fp, id)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(...values);
    else
      db.prepare(`UPDATE push_jobs SET phone_fp = ?, generation = ?, phase = ?, admitted_at = ?, expires_at = ?, due_at = ?,
      send_count = ?, check_count = ?, claim_id = ?, claim_until = ?, session_id = ?, kind = ?, exit_code = ?, duration_ms = ?,
      ticket_id = ?, accepted_at = ?, context_json = ? WHERE computer_fp = ? AND id = ?`).run(
        ...values,
      );
  };
  const clean = (now: number) => {
    db.prepare("DELETE FROM push_accepted WHERE computer_fp = ? AND expires_at <= ?").run(fp, now);
    for (const current of rows()) {
      const next = recoverJob(
        current,
        registration(current.phoneFp),
        options.attentive(current.phoneFp, now),
        now,
      );
      if (!next) remove(current.id);
      else if (next !== current) write(next);
    }
  };
  const currentClaim = (claim: Claim, now: number, dispatch: boolean): Job | undefined => {
    const row = db
      .prepare("SELECT * FROM push_jobs WHERE computer_fp = ? AND id = ?")
      .get(fp, claim.job.id);
    const current = row ? job(row) : undefined;
    return (dispatch ? dispatchable : ownsClaim)(
      claim,
      current,
      registration(claim.job.phoneFp),
      options.attentive(claim.job.phoneFp, now),
      now,
    )
      ? current
      : undefined;
  };
  const takeBudget = (phone: string, now: number) => {
    const cutoff = budgetCutoff(now);
    // Validate before expiry cleanup: corrupt old rows must not reset spent budget.
    const prior = db
      .prepare("SELECT count, window_start FROM push_limits WHERE computer_fp = ? AND phone_fp = ?")
      .get(fp, phone);
    const attemptTimes = db
      .prepare("SELECT attempted_at FROM push_attempts WHERE computer_fp = ? AND phone_fp = ?")
      .all(fp, phone)
      .map((row) => row.attempted_at);
    const legacy = legacyBudgetUsage(
      prior ? { count: prior.count, windowStart: prior.window_start } : undefined,
      attemptTimes,
      now,
    );
    db.prepare(
      "DELETE FROM push_attempts WHERE computer_fp = ? AND phone_fp = ? AND attempted_at <= ?",
    ).run(fp, phone, cutoff);
    db.prepare(
      "DELETE FROM push_limits WHERE computer_fp = ? AND phone_fp = ? AND window_start <= ?",
    ).run(fp, phone, cutoff);
    const count = Number(
      db
        .prepare("SELECT COUNT(*) AS n FROM push_attempts WHERE computer_fp = ? AND phone_fp = ?")
        .get(fp, phone)!.n,
    );
    if (!budgetAvailable(count, legacy)) return false;
    db.prepare(
      "INSERT INTO push_attempts (computer_fp, phone_fp, attempted_at) VALUES (?, ?, ?)",
    ).run(fp, phone, now);
    return true;
  };
  const reserve = (state: "pending-send", now: number, limit: number): readonly Claim[] => {
    identityTimestamp(now);
    if (!Number.isSafeInteger(limit) || limit < 0 || limit > 100)
      throw new Error("Claim limit must be between zero and one hundred");
    return transaction(() => {
      clean(now);
      const claims: Claim[] = [];
      const due = db
        .prepare(
          "SELECT * FROM push_jobs WHERE computer_fp = ? AND phase = ? AND due_at <= ? ORDER BY due_at, admitted_at, id LIMIT ?",
        )
        .all(fp, notificationJobPhase(state), now, limit)
        .map(job);
      for (const current of due) {
        const reg = registration(current.phoneFp);
        const next = claimJob(current, options.randomId(), now);
        if (
          !reg?.token ||
          !eligible(current, reg, options.attentive(current.phoneFp, now), now) ||
          !next ||
          (state === "pending-send" && !takeBudget(current.phoneFp, now))
        ) {
          remove(current.id);
          continue;
        }
        write(next);
        claims.push({ job: next, token: reg.token, registration: reg });
      }
      return claims;
    });
  };
  const finish = (
    claim: Claim,
    now: number,
    complete: (current: Job) => Completion,
    accepted = false,
  ) => {
    identityTimestamp(now);
    transaction(() => {
      const current = currentClaim(claim, now, false);
      if (!current) return;
      const result = complete(current);
      if (accepted && current.id.startsWith("v1:"))
        db.prepare(
          "INSERT OR IGNORE INTO push_accepted (computer_fp, id, phone_fp, expires_at) VALUES (?, ?, ?, ?)",
        ).run(fp, current.id, current.phoneFp, current.expiresAt);
      if (result.disableRegistration) {
        db.prepare(
          "UPDATE pairings SET push_token = NULL, push_platform = NULL, push_provider = NULL, push_environment = NULL WHERE computer_fp = ? AND phone_fp = ? AND push_token = ?",
        ).run(fp, current.phoneFp, claim.token);
        cancel(current.phoneFp);
      } else if (result.job) write(result.job);
      else remove(current.id);
    });
  };
  return {
    async register(phone, message, generation) {
      validatePushRegistration(message);
      transaction(() => {
        if (
          !db
            .prepare("SELECT phone_fp FROM pairings WHERE computer_fp = ? AND phone_fp = ?")
            .get(fp, phone)
        )
          return;
        cancel(phone);
        db.prepare(
          "UPDATE pairings SET push_token = ?, push_platform = ?, push_provider = ?, push_environment = ?, push_enabled = ? WHERE computer_fp = ? AND phone_fp = ?",
        ).run(
          message.token,
          message.platform,
          message.provider ?? null,
          message.environment ?? null,
          message.enabled ? 1 : 0,
          fp,
          phone,
        );
        db.prepare(`INSERT INTO push_registrations (computer_fp, phone_fp, generation, features) VALUES (?, ?, ?, ?)
          ON CONFLICT(computer_fp, phone_fp) DO UPDATE SET generation = excluded.generation, features = excluded.features`).run(
          fp,
          phone,
          generation,
          JSON.stringify(message.features ?? []),
        );
      });
    },
    async enqueue(message, now) {
      identityTimestamp(now);
      transaction(() => {
        const last =
          db
            .prepare(
              "SELECT last_ring_at FROM ring_limits WHERE computer_fp = ? AND session_id = ?",
            )
            .get(fp, message.sessionId)?.last_ring_at ?? null;
        if (!ringAllowed(last === null ? null : identityTimestamp(last), now)) return;
        db.prepare(`INSERT INTO ring_limits (computer_fp, session_id, last_ring_at) VALUES (?, ?, ?)
          ON CONFLICT(computer_fp, session_id) DO UPDATE SET last_ring_at = excluded.last_ring_at`).run(
          fp,
          message.sessionId,
          now,
        );
        db.prepare(`DELETE FROM ring_limits WHERE computer_fp = ? AND session_id NOT IN
          (SELECT session_id FROM ring_limits WHERE computer_fp = ? ORDER BY last_ring_at DESC, session_id LIMIT ?)`).run(
          fp,
          fp,
          notificationLimits.ringRows,
        );
        clean(now);
        for (const row of db
          .prepare(
            "SELECT phone_fp FROM pairings WHERE computer_fp = ? AND push_enabled = 1 AND push_token IS NOT NULL AND push_provider IN ('fcm', 'apns')",
          )
          .all(fp)) {
          const phone = text(row.phone_fp);
          if (options.attentive(phone, now)) continue;
          const total = Number(
            db
              .prepare(`SELECT COUNT(*) AS n FROM push_jobs WHERE computer_fp = ? AND NOT
            (phone_fp = ? AND COALESCE(session_id, '') = ? AND phase IN ('send', 'sending'))`)
              .get(fp, phone, message.sessionId)!.n,
          );
          const perPhone = Number(
            db
              .prepare(`SELECT COUNT(*) AS n FROM push_jobs WHERE computer_fp = ? AND phone_fp = ? AND NOT
            (COALESCE(session_id, '') = ? AND phase IN ('send', 'sending'))`)
              .get(fp, phone, message.sessionId)!.n,
          );
          const acceptedTotal = Number(
            db.prepare("SELECT COUNT(*) AS n FROM push_accepted WHERE computer_fp = ?").get(fp)!.n,
          );
          const acceptedPhone = Number(
            db
              .prepare(
                "SELECT COUNT(*) AS n FROM push_accepted WHERE computer_fp = ? AND phone_fp = ?",
              )
              .get(fp, phone)!.n,
          );
          if (!capacityAvailable(total + acceptedTotal, perPhone + acceptedPhone)) continue;
          db.prepare(
            "INSERT OR IGNORE INTO push_registrations (computer_fp, phone_fp, generation) VALUES (?, ?, ?)",
          ).run(fp, phone, options.randomId());
          const reg = registration(phone);
          if (!reg) continue;
          const id =
            message.type === "notify-context"
              ? `v1:${message.eventId}:${phone}`
              : options.randomId();
          if (
            db.prepare("SELECT id FROM push_jobs WHERE computer_fp = ? AND id = ?").get(fp, id) ||
            db.prepare("SELECT id FROM push_accepted WHERE computer_fp = ? AND id = ?").get(fp, id)
          )
            continue;
          const selectedContext = selectPushContext(message, phone, {
            computerFp: fp,
            phoneFp: phone,
            features: reg.features,
            platform: reg.platform,
          });
          db.prepare(
            "DELETE FROM push_jobs WHERE computer_fp = ? AND phone_fp = ? AND session_id = ? AND phase IN ('send', 'sending')",
          ).run(fp, phone, message.sessionId);
          write(newJob(id, phone, reg.generation, message, now, selectedContext), true);
        }
      });
    },
    async cancelPhone(phone) {
      transaction(() => cancel(phone));
    },
    async claimSends(now, limit) {
      return reserve("pending-send", now, limit);
    },
    async isCurrent(claim, now) {
      assertOpen();
      identityTimestamp(now);
      return !!currentClaim(claim, now, true);
    },
    async finishSend(claim, outcome, now) {
      finish(
        claim,
        now,
        (current) => sendCompleted(current, outcome, now),
        outcome.status === "accepted",
      );
    },
    async recover(now) {
      identityTimestamp(now);
      transaction(() => clean(now));
    },
    async nextDeadline() {
      assertOpen();
      const pending = notificationDeadline(rows());
      const accepted = db
        .prepare("SELECT MIN(expires_at) AS deadline FROM push_accepted WHERE computer_fp = ?")
        .get(fp)!.deadline as number | null;
      return pending === null
        ? accepted
        : accepted === null
          ? pending
          : Math.min(pending, accepted);
    },
  };
}
