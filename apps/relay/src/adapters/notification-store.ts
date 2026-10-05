import { parseCtrl } from "@shellbell/protocol";
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

type Row = Record<string, SqlStorageValue>;
function job(row: Row): Job {
  let context: Job["context"] = null;
  try {
    context = decodeNotificationContext(row.context_json as string | null);
  } catch {
    /* Legacy or malformed context falls back to a generic message. */
  }
  return {
    id: row.id as string,
    phoneFp: row.phone_fp as string,
    generation: row.generation as string,
    state: notificationJobStates[row.phase as keyof typeof notificationJobStates],
    admittedAt: identityTimestamp(row.admitted_at),
    expiresAt: identityTimestamp(row.expires_at),
    dueAt: identityTimestamp(row.due_at),
    sendCount: identityTimestamp(row.send_count),
    checkCount: identityTimestamp(row.check_count),
    claimId: row.claim_id as string | null,
    claimUntil: row.claim_until === null ? null : identityTimestamp(row.claim_until),
    sessionId: row.session_id as string | null,
    kind: row.kind as Job["kind"],
    exitCode: row.exit_code as number | null,
    durationMs: row.duration_ms === null ? null : identityTimestamp(row.duration_ms),
    ticketId: row.ticket_id as string | null,
    acceptedAt: row.accepted_at === null ? null : identityTimestamp(row.accepted_at),
    context,
  };
}
export interface CloudflareNotificationStoreOptions {
  computerFp: string;
  attentive(phoneFp: string, now: number): boolean;
  randomId(): string;
}

/** Maps the existing schema to detached domain snapshots; no external I/O inside transactions. */
export function createCloudflareNotificationStore(
  storage: DurableObjectStorage,
  options: CloudflareNotificationStoreOptions,
): NotificationStore {
  const sql = storage.sql;
  const exists = () =>
    sql.exec("SELECT name FROM sqlite_master WHERE name = 'push_jobs'").toArray().length > 0;
  const remove = (id: string) => {
    sql.exec("DELETE FROM push_jobs WHERE id = ?", id);
  };
  const cancel = (phone: string) => {
    sql.exec("DELETE FROM push_jobs WHERE phone_fp = ?", phone);
    sql.exec("DELETE FROM push_accepted WHERE phone_fp = ?", phone);
  };
  const rows = () => sql.exec<Row>("SELECT * FROM push_jobs").toArray().map(job);
  const registration = (phone: string): Registration | undefined => {
    const row = sql
      .exec<Row>(
        "SELECT r.generation, r.features, p.push_token, p.push_enabled, p.push_platform, p.push_provider, p.push_environment FROM push_registrations r JOIN pairings p ON p.phone_fp = r.phone_fp WHERE r.phone_fp = ?",
        phone,
      )
      .toArray()[0];
    if (!row) return undefined;
    let features: string[] = [];
    try {
      features = decodeNotificationFeatures((row.features as string | null) ?? "[]");
    } catch {
      /* legacy */
    }
    return {
      generation: row.generation as string,
      token: row.push_token as string | null,
      enabled: row.push_enabled === 1,
      platform: row.push_platform as string | null,
      provider: row.push_provider as Registration["provider"],
      environment: row.push_environment as Registration["environment"],
      features,
    };
  };
  const write = (value: Job, insert = false) => {
    const values = [...notificationJobFields(value), value.id];
    if (insert) {
      sql.exec(
        "INSERT INTO push_jobs (phone_fp, generation, phase, admitted_at, expires_at, due_at, send_count, check_count, claim_id, claim_until, session_id, kind, exit_code, duration_ms, ticket_id, accepted_at, context_json, id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        ...values,
      );
    } else {
      sql.exec(
        "UPDATE push_jobs SET phone_fp = ?, generation = ?, phase = ?, admitted_at = ?, expires_at = ?, due_at = ?, send_count = ?, check_count = ?, claim_id = ?, claim_until = ?, session_id = ?, kind = ?, exit_code = ?, duration_ms = ?, ticket_id = ?, accepted_at = ?, context_json = ? WHERE id = ?",
        ...values,
      );
    }
  };
  const clean = (now: number) => {
    sql.exec("DELETE FROM push_accepted WHERE expires_at <= ?", now);
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
    const row = sql.exec<Row>("SELECT * FROM push_jobs WHERE id = ?", claim.job.id).toArray()[0];
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
    const prior = sql
      .exec<Row>("SELECT count, window_start FROM push_limits WHERE phone_fp = ?", phone)
      .toArray()[0];
    function* attemptTimes() {
      for (const row of sql.exec<Row>(
        "SELECT attempted_at FROM push_attempts WHERE phone_fp = ?",
        phone,
      ))
        yield row.attempted_at;
    }
    const legacy = legacyBudgetUsage(
      prior ? { count: prior.count, windowStart: prior.window_start } : undefined,
      attemptTimes(),
      now,
    );
    sql.exec("DELETE FROM push_attempts WHERE phone_fp = ? AND attempted_at <= ?", phone, cutoff);
    sql.exec("DELETE FROM push_limits WHERE phone_fp = ? AND window_start <= ?", phone, cutoff);
    const count = sql
      .exec<{ n: number }>("SELECT COUNT(*) AS n FROM push_attempts WHERE phone_fp = ?", phone)
      .one().n;
    if (!budgetAvailable(count, legacy)) return false;
    sql.exec("INSERT INTO push_attempts (phone_fp, attempted_at) VALUES (?, ?)", phone, now);
    return true;
  };
  const reserve = (state: "pending-send", now: number, limit: number): readonly Claim[] => {
    if (!exists()) return [];
    return storage.transactionSync(() => {
      clean(now);
      const claims: Claim[] = [];
      const due = sql
        .exec<Row>(
          "SELECT * FROM push_jobs WHERE phase = ? AND due_at <= ? ORDER BY due_at, admitted_at, id LIMIT ?",
          notificationJobPhase(state),
          now,
          limit,
        )
        .toArray()
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
    if (!exists()) return;
    storage.transactionSync(() => {
      const current = currentClaim(claim, now, false);
      if (!current) return;
      const result = complete(current);
      if (accepted && current.id.startsWith("v1:"))
        sql.exec(
          "INSERT OR IGNORE INTO push_accepted (id, phone_fp, expires_at) VALUES (?, ?, ?)",
          current.id,
          current.phoneFp,
          current.expiresAt,
        );
      if (result.disableRegistration) {
        sql.exec(
          "UPDATE pairings SET push_token = NULL, push_platform = NULL, push_provider = NULL, push_environment = NULL WHERE phone_fp = ? AND push_token = ?",
          current.phoneFp,
          claim.token,
        );
        cancel(current.phoneFp);
      } else if (result.job) write(result.job);
      else remove(current.id);
    });
  };
  return {
    async register(phone, message, generation) {
      parseCtrl(message);
      if (!exists()) return;
      storage.transactionSync(() => {
        if (!sql.exec("SELECT phone_fp FROM pairings WHERE phone_fp = ?", phone).toArray().length)
          return;
        cancel(phone);
        sql.exec(
          "UPDATE pairings SET push_token = ?, push_platform = ?, push_provider = ?, push_environment = ?, push_enabled = ? WHERE phone_fp = ?",
          message.token,
          message.platform,
          message.provider ?? null,
          message.environment ?? null,
          message.enabled ? 1 : 0,
          phone,
        );
        sql.exec(
          "INSERT INTO push_registrations (phone_fp, generation, features) VALUES (?, ?, ?) ON CONFLICT(phone_fp) DO UPDATE SET generation = excluded.generation, features = excluded.features",
          phone,
          generation,
          JSON.stringify(message.features ?? []),
        );
      });
    },
    async enqueue(message, now) {
      if (!exists()) return;
      storage.transactionSync(() => {
        const last =
          sql
            .exec<{ last_ring_at: number }>(
              "SELECT last_ring_at FROM ring_limits WHERE session_id = ?",
              message.sessionId,
            )
            .toArray()[0]?.last_ring_at ?? null;
        if (!ringAllowed(last, now)) return;
        sql.exec(
          "INSERT INTO ring_limits (session_id, last_ring_at) VALUES (?, ?) ON CONFLICT(session_id) DO UPDATE SET last_ring_at = excluded.last_ring_at",
          message.sessionId,
          now,
        );
        sql.exec(
          "DELETE FROM ring_limits WHERE session_id NOT IN (SELECT session_id FROM ring_limits ORDER BY last_ring_at DESC LIMIT ?)",
          notificationLimits.ringRows,
        );
        clean(now);
        for (const { phone_fp: phone } of sql
          .exec<{ phone_fp: string }>(
            "SELECT phone_fp FROM pairings WHERE push_enabled = 1 AND push_token IS NOT NULL AND push_provider IN ('fcm', 'apns')",
          )
          .toArray()) {
          if (options.attentive(phone, now)) continue;
          const total = sql
            .exec<{ n: number }>(
              "SELECT COUNT(*) AS n FROM push_jobs WHERE NOT (phone_fp = ? AND session_id = ? AND phase IN ('send', 'sending'))",
              phone,
              message.sessionId,
            )
            .one().n;
          const perPhone = sql
            .exec<{ n: number }>(
              "SELECT COUNT(*) AS n FROM push_jobs WHERE phone_fp = ? AND NOT (COALESCE(session_id, '') = ? AND phase IN ('send', 'sending'))",
              phone,
              message.sessionId,
            )
            .one().n;
          const acceptedTotal = Number(sql.exec("SELECT COUNT(*) AS n FROM push_accepted").one().n);
          const acceptedPhone = Number(
            sql.exec("SELECT COUNT(*) AS n FROM push_accepted WHERE phone_fp = ?", phone).one().n,
          );
          if (!capacityAvailable(total + acceptedTotal, perPhone + acceptedPhone)) continue;
          sql.exec(
            "INSERT OR IGNORE INTO push_registrations (phone_fp, generation) VALUES (?, ?)",
            phone,
            options.randomId(),
          );
          const reg = registration(phone);
          if (!reg) continue;
          const id =
            message.type === "notify-context"
              ? `v1:${message.eventId}:${phone}`
              : options.randomId();
          if (
            sql.exec("SELECT id FROM push_jobs WHERE id = ?", id).toArray().length ||
            sql.exec("SELECT id FROM push_accepted WHERE id = ?", id).toArray().length
          )
            continue;
          const context = selectPushContext(message, phone, {
            computerFp: options.computerFp,
            phoneFp: phone,
            features: reg.features,
            platform: reg.platform,
          });
          sql.exec(
            "DELETE FROM push_jobs WHERE phone_fp = ? AND session_id = ? AND phase IN ('send', 'sending')",
            phone,
            message.sessionId,
          );
          write(newJob(id, phone, reg.generation, message, now, context), true);
        }
      });
    },
    async cancelPhone(phone) {
      if (exists()) storage.transactionSync(() => cancel(phone));
    },
    async claimSends(now, limit) {
      return reserve("pending-send", now, limit);
    },
    async isCurrent(claim, now) {
      return exists() && !!currentClaim(claim, now, true);
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
      if (exists()) storage.transactionSync(() => clean(now));
    },
    async nextDeadline() {
      if (!exists()) return null;
      const pending = notificationDeadline(rows());
      const accepted = sql.exec("SELECT MIN(expires_at) AS deadline FROM push_accepted").one()
        .deadline as number | null;
      return pending === null
        ? accepted
        : accepted === null
          ? pending
          : Math.min(pending, accepted);
    },
  };
}
