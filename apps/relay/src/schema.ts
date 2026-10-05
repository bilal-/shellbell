export const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS computer (
  fp TEXT PRIMARY KEY,
  ed25519_pub BLOB NOT NULL,
  name TEXT,
  first_seen INTEGER NOT NULL,
  last_seen INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS pairings (
  phone_fp TEXT PRIMARY KEY,
  ed25519_pub BLOB NOT NULL,
  pair_id BLOB CHECK(pair_id IS NULL OR length(pair_id) = 32),
  name TEXT NOT NULL,
  push_token TEXT,
  push_platform TEXT,
  push_provider TEXT,
  push_environment TEXT,
  push_enabled INTEGER NOT NULL DEFAULT 1,
  paired_at INTEGER NOT NULL,
  last_seen INTEGER
);
CREATE TABLE IF NOT EXISTS pending_unpairs (
  phone_fp TEXT PRIMARY KEY,
  at INTEGER NOT NULL,
  proof BLOB CHECK(proof IS NULL OR length(proof) <= 256)
);
CREATE TABLE IF NOT EXISTS pairing_window (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  gate_hash BLOB NOT NULL,
  expires_at INTEGER NOT NULL,
  admitted INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS ring_limits (
  session_id TEXT PRIMARY KEY,
  last_ring_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS push_limits (
  phone_fp TEXT PRIMARY KEY,
  window_start INTEGER NOT NULL,
  count INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS push_attempts (
  id INTEGER PRIMARY KEY,
  phone_fp TEXT NOT NULL,
  attempted_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS push_attempts_phone_time
  ON push_attempts (phone_fp, attempted_at);

CREATE TABLE IF NOT EXISTS push_registrations (
  phone_fp TEXT PRIMARY KEY,
  generation TEXT NOT NULL,
  features TEXT
);
CREATE TABLE IF NOT EXISTS push_accepted (
  id TEXT PRIMARY KEY,
  phone_fp TEXT NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS push_jobs (
  id TEXT PRIMARY KEY,
  phone_fp TEXT NOT NULL,
  generation TEXT NOT NULL,
  phase TEXT NOT NULL CHECK (phase IN ('send', 'sending', 'receipt', 'checking')),
  admitted_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  due_at INTEGER NOT NULL,
  send_count INTEGER NOT NULL DEFAULT 0,
  check_count INTEGER NOT NULL DEFAULT 0,
  claim_id TEXT,
  claim_until INTEGER,
  session_id TEXT,
  kind TEXT,
  exit_code INTEGER,
  duration_ms INTEGER,
  ticket_id TEXT CHECK (ticket_id IS NULL OR length(ticket_id) BETWEEN 1 AND 256),
  accepted_at INTEGER,
  context_json TEXT CHECK (context_json IS NULL OR length(context_json) <= 3500)
);
CREATE INDEX IF NOT EXISTS push_jobs_due ON push_jobs (due_at);
CREATE INDEX IF NOT EXISTS push_jobs_phone ON push_jobs (phone_fp);
`;

/** Additive upgrade for existing hosted/self-hosted SQLite objects. */
export function upgradePushContextSchema(sql: SqlStorage): void {
  const destinations = sql.exec<{ name: string }>("PRAGMA table_info(pairings)").toArray();
  for (const column of ["push_provider", "push_environment"]) {
    if (!destinations.some((entry) => entry.name === column))
      sql.exec(`ALTER TABLE pairings ADD COLUMN ${column} TEXT`);
  }
  sql.exec(
    "CREATE TABLE IF NOT EXISTS push_accepted (id TEXT PRIMARY KEY, phone_fp TEXT NOT NULL, expires_at INTEGER NOT NULL)",
  );
  const registrations = sql
    .exec<{ name: string }>("PRAGMA table_info(push_registrations)")
    .toArray();
  if (!registrations.some((c) => c.name === "features"))
    sql.exec("ALTER TABLE push_registrations ADD COLUMN features TEXT");
  const jobs = sql.exec<{ name: string }>("PRAGMA table_info(push_jobs)").toArray();
  if (!jobs.some((c) => c.name === "context_json"))
    sql.exec(
      "ALTER TABLE push_jobs ADD COLUMN context_json TEXT CHECK (context_json IS NULL OR length(context_json) <= 3500)",
    );
}

/** Existing Durable Objects predate the signed revocation proof column. */
export function upgradeRevocationProofSchema(sql: SqlStorage): void {
  const columns = sql.exec<{ name: string }>("PRAGMA table_info(pending_unpairs)").toArray();
  if (!columns.some((column) => column.name === "proof")) {
    sql.exec(
      "ALTER TABLE pending_unpairs ADD COLUMN proof BLOB CHECK(proof IS NULL OR length(proof) <= 256)",
    );
  }
}

/** Existing Durable Objects predate pair-scoped relay metadata. */
export function upgradePairIdSchema(sql: SqlStorage): void {
  const columns = sql.exec<{ name: string }>("PRAGMA table_info(pairings)").toArray();
  if (!columns.some((column) => column.name === "pair_id")) {
    sql.exec(
      "ALTER TABLE pairings ADD COLUMN pair_id BLOB CHECK(pair_id IS NULL OR length(pair_id) = 32)",
    );
  }
}
