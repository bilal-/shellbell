import {
  bytesEqual,
  decodePairRevocationV2,
  encodePairRevocationV2,
  FpSchema,
  MAX_PAIRINGS,
  ProtocolError,
} from "@shellbell/protocol";
import {
  type ComputerRecord,
  decodeComputerRecord,
  decodePairingRecord,
  decodePairingWindow,
  GC_AFTER_MS,
  type IdentityStore,
  identityTimestamp,
  MAX_PAIRING_ADMISSIONS,
  type PairingRecord,
  type PairingWindow,
} from "@shellbell/relay-core";

type Row = Record<string, SqlStorageValue>;

function bytes(value: SqlStorageValue | undefined): Uint8Array {
  if (!(value instanceof ArrayBuffer))
    throw new ProtocolError("malformed", "invalid identity blob");
  return new Uint8Array(value).slice();
}

function blob(value: Uint8Array): ArrayBuffer {
  return new Uint8Array(value).buffer;
}

function pairingRecord(row: Row): PairingRecord {
  if (row.push_enabled !== 0 && row.push_enabled !== 1)
    throw new ProtocolError("malformed", "invalid push setting");
  return decodePairingRecord({
    phoneFp: row.phone_fp,
    publicKey: bytes(row.ed25519_pub),
    pairId: row.pair_id === null ? undefined : bytes(row.pair_id),
    name: row.name,
    pushToken: row.push_token,
    pushPlatform: row.push_platform,
    ...(row.push_provider ? { pushProvider: row.push_provider as "fcm" | "apns" } : {}),
    ...(row.push_environment
      ? { pushEnvironment: row.push_environment as "development" | "production" }
      : {}),
    pushEnabled: row.push_enabled === 1,
    pairedAt: row.paired_at,
    lastSeenAt: row.last_seen,
  });
}

/** Uses the existing schema; its initialization and scheduling stay with the runtime. */
export function createCloudflareIdentityStore(
  storage: DurableObjectStorage,
  computerFp: string,
): IdentityStore {
  FpSchema.parse(computerFp);
  const sql = storage.sql;

  function computer(): ComputerRecord | null {
    const row = sql.exec<Row>("SELECT * FROM computer WHERE fp = ?", computerFp).toArray()[0];
    return row
      ? decodeComputerRecord({
          fingerprint: row.fp,
          publicKey: bytes(row.ed25519_pub),
          name: row.name,
          firstSeen: row.first_seen,
          lastSeen: row.last_seen,
        })
      : null;
  }

  function pairings(): PairingRecord[] {
    return sql.exec<Row>("SELECT * FROM pairings ORDER BY phone_fp").toArray().map(pairingRecord);
  }

  function window(): PairingWindow | null {
    const row = sql.exec<Row>("SELECT * FROM pairing_window WHERE id = 1").toArray()[0];
    return row
      ? decodePairingWindow({
          gateHash: bytes(row.gate_hash),
          expiresAt: row.expires_at,
          admitted: row.admitted,
        })
      : null;
  }

  function pendingRevocations(): string[] {
    return sql
      .exec<Row>("SELECT phone_fp FROM pending_unpairs ORDER BY at, phone_fp")
      .toArray()
      .map((row) => FpSchema.parse(row.phone_fp));
  }

  function upsert(record: PairingRecord): void {
    sql.exec(
      `INSERT INTO pairings (phone_fp, ed25519_pub, pair_id, name, push_token, push_platform, push_provider, push_environment, push_enabled, paired_at, last_seen)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(phone_fp) DO UPDATE SET ed25519_pub = excluded.ed25519_pub, pair_id = excluded.pair_id, name = excluded.name`,
      record.phoneFp,
      blob(record.publicKey),
      record.pairId ? blob(record.pairId) : null,
      record.name,
      record.pushToken,
      record.pushPlatform,
      record.pushProvider ?? null,
      record.pushEnvironment ?? null,
      record.pushEnabled ? 1 : 0,
      record.pairedAt,
      record.lastSeenAt,
    );
  }

  function remove(phoneFp: string): void {
    sql.exec("DELETE FROM push_jobs WHERE phone_fp = ?", phoneFp);
    sql.exec("DELETE FROM push_accepted WHERE phone_fp = ?", phoneFp);
    sql.exec("DELETE FROM push_registrations WHERE phone_fp = ?", phoneFp);
    sql.exec("DELETE FROM pairings WHERE phone_fp = ?", phoneFp);
    sql.exec("DELETE FROM push_limits WHERE phone_fp = ?", phoneFp);
    sql.exec("DELETE FROM push_attempts WHERE phone_fp = ?", phoneFp);
  }

  return {
    async computer() {
      return computer();
    },
    async pairings() {
      return pairings();
    },
    async pairing(phoneFp) {
      FpSchema.parse(phoneFp);
      const row = sql.exec<Row>("SELECT * FROM pairings WHERE phone_fp = ?", phoneFp).toArray()[0];
      return row ? pairingRecord(row) : null;
    },
    async window() {
      return window();
    },
    async pendingRevocations() {
      return pendingRevocations();
    },
    async pendingRevocationProofs() {
      return sql
        .exec<Row>(
          "SELECT proof FROM pending_unpairs WHERE proof IS NOT NULL ORDER BY at, phone_fp",
        )
        .toArray()
        .map((row) => decodePairRevocationV2(bytes(row.proof)));
    },
    async acknowledgeRevocationProof(phoneFp, pairId) {
      FpSchema.parse(phoneFp);
      if (pairId.length !== 32) throw new ProtocolError("malformed", "invalid pair ID");
      return storage.transactionSync(() => {
        const row = sql
          .exec<Row>("SELECT proof FROM pending_unpairs WHERE phone_fp = ?", phoneFp)
          .toArray()[0];
        if (!row || row.proof === null) return false;
        const proof = decodePairRevocationV2(bytes(row.proof));
        if (!bytesEqual(proof.pairId, pairId)) return false;
        sql.exec(
          "DELETE FROM pending_unpairs WHERE phone_fp = ? AND proof = ?",
          phoneFp,
          row.proof,
        );
        return true;
      });
    },
    async registerComputer(value) {
      const record = decodeComputerRecord(value);
      if (record.fingerprint !== computerFp)
        throw new ProtocolError("malformed", "computer ownership mismatch");
      sql.exec(
        `INSERT INTO computer (fp, ed25519_pub, name, first_seen, last_seen) VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(fp) DO UPDATE SET name = excluded.name, last_seen = excluded.last_seen`,
        computerFp,
        blob(record.publicKey),
        record.name,
        record.firstSeen,
        record.lastSeen,
      );
    },
    async openWindow(gateHash, expiresAt) {
      const record = decodePairingWindow({ gateHash, expiresAt, admitted: 0 });
      sql.exec(
        `INSERT INTO pairing_window (id, gate_hash, expires_at, admitted) VALUES (1, ?, ?, 0)
        ON CONFLICT(id) DO UPDATE SET gate_hash = excluded.gate_hash, expires_at = excluded.expires_at, admitted = 0`,
        blob(record.gateHash),
        record.expiresAt,
      );
    },
    async closeWindow() {
      sql.exec("DELETE FROM pairing_window WHERE id = 1");
    },
    async admitPairing(gateHash, now) {
      const gate = decodePairingWindow({ gateHash, expiresAt: now, admitted: 0 }).gateHash;
      return storage.transactionSync(() => {
        const current = window();
        if (!current || !bytesEqual(current.gateHash, gate)) return "closed";
        if (now >= current.expiresAt) return "expired";
        if (current.admitted >= MAX_PAIRING_ADMISSIONS) return "full";
        sql.exec("UPDATE pairing_window SET admitted = admitted + 1 WHERE id = 1");
        return "admitted";
      });
    },
    async addPairing(value, now) {
      const record = decodePairingRecord(value);
      identityTimestamp(now);
      return storage.transactionSync(() => {
        if (pendingRevocations().includes(record.phoneFp)) return "revoked";
        const count = sql
          .exec<{ n: number }>(
            "SELECT COUNT(*) AS n FROM pairings WHERE phone_fp != ?",
            record.phoneFp,
          )
          .one().n;
        if (count >= MAX_PAIRINGS) return "full";
        upsert(record);
        return "added";
      });
    },
    async revoke(phoneFp, tombstone, now, proof) {
      FpSchema.parse(phoneFp);
      identityTimestamp(now);
      if (proof && (proof.phoneFp !== phoneFp || proof.computerFp !== computerFp)) {
        throw new ProtocolError("malformed", "revocation proof routing mismatch");
      }
      const encodedProof = proof ? blob(encodePairRevocationV2(proof)) : null;
      return storage.transactionSync(() => {
        const pending = pendingRevocations();
        const canStore = tombstone && (pending.includes(phoneFp) || pending.length < MAX_PAIRINGS);
        if (proof && !canStore) return false;
        remove(phoneFp);
        if (canStore) {
          sql.exec(
            `INSERT INTO pending_unpairs (phone_fp, at, proof) VALUES (?, ?, ?)
             ON CONFLICT(phone_fp) DO UPDATE SET
               at = excluded.at, proof = COALESCE(excluded.proof, pending_unpairs.proof)`,
            phoneFp,
            now,
            encodedProof,
          );
        }
        return canStore;
      });
    },
    async syncPairings(values, now) {
      identityTimestamp(now);
      if (values.length > MAX_PAIRINGS) throw new ProtocolError("malformed", "too many pairings");
      const records = values.map(decodePairingRecord);
      if (new Set(records.map((r) => r.phoneFp)).size !== records.length)
        throw new ProtocolError("malformed", "duplicate pairings");
      return storage.transactionSync(() => {
        const revoked = pendingRevocations();
        const tombstones = new Set(revoked);
        const accepted = records.filter((r) => !tombstones.has(r.phoneFp));
        const keep = new Set(accepted.map((r) => r.phoneFp));
        for (const fp of revoked) remove(fp);
        for (const row of pairings()) if (!keep.has(row.phoneFp)) remove(row.phoneFp);
        for (const record of accepted) upsert(record);
        sql.exec("DELETE FROM pending_unpairs WHERE proof IS NULL");
        return revoked;
      });
    },
    async markSeen(now) {
      identityTimestamp(now);
      sql.exec("UPDATE computer SET last_seen = ? WHERE fp = ?", now, computerFp);
    },
    async markPairingSeen(phoneFp, now) {
      FpSchema.parse(phoneFp);
      identityTimestamp(now);
      sql.exec("UPDATE pairings SET last_seen = ? WHERE phone_fp = ?", now, phoneFp);
    },
    async deleteExpiredComputer(now) {
      identityTimestamp(now);
      return storage.transactionSync(() => {
        const row = computer();
        if (!row || now - row.lastSeen <= GC_AFTER_MS) return false;
        sql.exec(`DELETE FROM push_jobs; DELETE FROM push_accepted; DELETE FROM push_registrations; DELETE FROM push_attempts;
          DELETE FROM push_limits; DELETE FROM ring_limits; DELETE FROM pairing_window;
          DELETE FROM pending_unpairs; DELETE FROM pairings; DELETE FROM computer;`);
        return true;
      });
    },
    async deleteOrphanedComputer() {
      return storage.transactionSync(() => {
        if (computer()) return false;
        sql.exec(`DELETE FROM push_jobs; DELETE FROM push_accepted; DELETE FROM push_registrations; DELETE FROM push_attempts;
          DELETE FROM push_limits; DELETE FROM ring_limits; DELETE FROM pairing_window;
          DELETE FROM pending_unpairs; DELETE FROM pairings;`);
        return true;
      });
    },
  };
}
