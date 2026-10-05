import type { DatabaseSync } from "node:sqlite";

/** Standalone schema; unrelated to Durable Object migrations. Every key starts with computer_fp. */
export function initializeSchema(db: DatabaseSync): void {
  const version = db.prepare("PRAGMA user_version").get()!.user_version;
  if (
    version !== 0 &&
    version !== 1 &&
    version !== 2 &&
    version !== 3 &&
    version !== 4 &&
    version !== 5
  )
    throw new Error(`Unsupported relay schema version: ${version}`);
  if (version === 5) return;
  if (version === 4) {
    const columns = db.prepare("PRAGMA table_info(pairings)").all();
    db.exec(`BEGIN IMMEDIATE;
      ${columns.some((column) => column.name === "push_provider") ? "" : "ALTER TABLE pairings ADD COLUMN push_provider TEXT;"}
      ${columns.some((column) => column.name === "push_environment") ? "" : "ALTER TABLE pairings ADD COLUMN push_environment TEXT;"}
      CREATE TABLE IF NOT EXISTS push_accepted (computer_fp TEXT NOT NULL, id TEXT NOT NULL, phone_fp TEXT NOT NULL, expires_at INTEGER NOT NULL, PRIMARY KEY(computer_fp, id)) STRICT;
      PRAGMA user_version = 5;
      COMMIT;`);
    return;
  }
  if (version === 3) {
    const hasPairId = db
      .prepare("PRAGMA table_info(pairings)")
      .all()
      .some((column) => column.name === "pair_id");
    db.exec(`BEGIN IMMEDIATE;
      ${hasPairId ? "" : "ALTER TABLE pairings ADD COLUMN pair_id BLOB CHECK(pair_id IS NULL OR length(pair_id) = 32);"}
      PRAGMA user_version = 4; COMMIT;`);
    initializeSchema(db);
    return;
  }
  if (version === 2) {
    const hasProof = db
      .prepare("PRAGMA table_info(pending_unpairs)")
      .all()
      .some((column) => column.name === "proof");
    db.exec(`BEGIN IMMEDIATE;
      ${hasProof ? "" : "ALTER TABLE pending_unpairs ADD COLUMN proof BLOB CHECK(proof IS NULL OR length(proof) <= 256);"}
      PRAGMA user_version = 3; COMMIT;`);
    initializeSchema(db);
    return;
  }
  if (version === 1) {
    db.exec(`BEGIN IMMEDIATE;
      CREATE TABLE computer_deadlines (
        computer_fp TEXT PRIMARY KEY, deadline INTEGER NOT NULL CHECK(deadline >= 0)
      ) STRICT;
    PRAGMA user_version = 2; COMMIT;`);
    initializeSchema(db);
    return;
  }
  if (db.prepare("SELECT name FROM sqlite_master WHERE name NOT LIKE 'sqlite_%'").get()) {
    throw new Error("Refusing an unversioned nonempty relay database");
  }
  db.exec(`BEGIN IMMEDIATE;
    CREATE TABLE computer (
      computer_fp TEXT PRIMARY KEY, ed25519_pub BLOB NOT NULL, name TEXT,
      first_seen INTEGER NOT NULL, last_seen INTEGER NOT NULL
    ) STRICT;
    CREATE TABLE pairings (
      computer_fp TEXT NOT NULL, phone_fp TEXT NOT NULL, ed25519_pub BLOB NOT NULL,
      pair_id BLOB CHECK(pair_id IS NULL OR length(pair_id) = 32),
      name TEXT NOT NULL, push_token TEXT, push_platform TEXT,
      push_provider TEXT, push_environment TEXT,
      push_enabled INTEGER NOT NULL DEFAULT 1 CHECK(push_enabled IN (0, 1)),
      paired_at INTEGER NOT NULL, last_seen INTEGER, PRIMARY KEY(computer_fp, phone_fp)
    ) STRICT;
  CREATE TABLE pending_unpairs (
    computer_fp TEXT NOT NULL, phone_fp TEXT NOT NULL, at INTEGER NOT NULL,
    proof BLOB CHECK(proof IS NULL OR length(proof) <= 256),
      PRIMARY KEY(computer_fp, phone_fp)
    ) STRICT;
    CREATE TABLE pairing_window (
      computer_fp TEXT PRIMARY KEY, gate_hash BLOB NOT NULL,
      expires_at INTEGER NOT NULL, admitted INTEGER NOT NULL CHECK(admitted BETWEEN 0 AND 5)
    ) STRICT;
    CREATE TABLE ring_limits (
      computer_fp TEXT NOT NULL, session_id TEXT NOT NULL, last_ring_at INTEGER NOT NULL,
      PRIMARY KEY(computer_fp, session_id)
    ) STRICT;
    CREATE INDEX ring_limits_recent ON ring_limits(computer_fp, last_ring_at);
    CREATE TABLE push_limits (
      computer_fp TEXT NOT NULL, phone_fp TEXT NOT NULL, window_start INTEGER NOT NULL,
      count INTEGER NOT NULL, PRIMARY KEY(computer_fp, phone_fp)
    ) STRICT;
    CREATE TABLE push_attempts (
      computer_fp TEXT NOT NULL, id TEXT NOT NULL DEFAULT (hex(randomblob(16))),
      phone_fp TEXT NOT NULL, attempted_at INTEGER NOT NULL, PRIMARY KEY(computer_fp, id)
    ) STRICT;
    CREATE INDEX push_attempts_phone_time ON push_attempts(computer_fp, phone_fp, attempted_at);
    CREATE TABLE push_registrations (
      computer_fp TEXT NOT NULL, phone_fp TEXT NOT NULL, generation TEXT NOT NULL, features TEXT,
      PRIMARY KEY(computer_fp, phone_fp),
      FOREIGN KEY(computer_fp, phone_fp) REFERENCES pairings(computer_fp, phone_fp)
    ) STRICT;
    CREATE TABLE push_accepted (computer_fp TEXT NOT NULL, id TEXT NOT NULL, phone_fp TEXT NOT NULL, expires_at INTEGER NOT NULL, PRIMARY KEY(computer_fp, id)) STRICT;
    CREATE TABLE push_jobs (
      computer_fp TEXT NOT NULL, id TEXT NOT NULL, phone_fp TEXT NOT NULL, generation TEXT NOT NULL,
      phase TEXT NOT NULL CHECK(phase IN ('send', 'sending', 'receipt', 'checking')),
      admitted_at INTEGER NOT NULL, expires_at INTEGER NOT NULL, due_at INTEGER NOT NULL,
      send_count INTEGER NOT NULL DEFAULT 0, check_count INTEGER NOT NULL DEFAULT 0,
      claim_id TEXT, claim_until INTEGER, session_id TEXT, kind TEXT, exit_code INTEGER,
      duration_ms INTEGER, ticket_id TEXT CHECK(ticket_id IS NULL OR length(ticket_id) BETWEEN 1 AND 256),
      accepted_at INTEGER, context_json TEXT CHECK(context_json IS NULL OR length(context_json) <= 3500),
      PRIMARY KEY(computer_fp, id),
      FOREIGN KEY(computer_fp, phone_fp) REFERENCES pairings(computer_fp, phone_fp)
    ) STRICT;
    CREATE INDEX push_jobs_due ON push_jobs(computer_fp, phase, due_at, admitted_at, id);
    CREATE INDEX push_jobs_phone ON push_jobs(computer_fp, phone_fp);
    CREATE TABLE computer_deadlines (
      computer_fp TEXT PRIMARY KEY, deadline INTEGER NOT NULL CHECK(deadline >= 0)
    ) STRICT;
  PRAGMA user_version = 5;
    COMMIT;`);
}
