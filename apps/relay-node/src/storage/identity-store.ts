import type { SQLOutputValue } from "node:sqlite";
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
import type { NodeDatabase } from "./database.js";
import { validateRepositoryInput } from "./input-validation.js";

type Row = Record<string, SQLOutputValue>;
function pairingRecord(row: Row): PairingRecord {
  if (row.push_enabled !== 0 && row.push_enabled !== 1)
    throw new ProtocolError("malformed", "invalid push setting");
  return decodePairingRecord({
    phoneFp: row.phone_fp,
    publicKey: row.ed25519_pub,
    pairId: row.pair_id === null ? undefined : row.pair_id,
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
export function createNodeIdentityStore(context: NodeDatabase, fp: string): IdentityStore {
  const { db, transaction, assertOpen } = context;
  function computer(): ComputerRecord | null {
    assertOpen();
    const row = db.prepare("SELECT * FROM computer WHERE computer_fp = ?").get(fp);
    return row
      ? decodeComputerRecord({
          fingerprint: row.computer_fp,
          publicKey: row.ed25519_pub,
          name: row.name,
          firstSeen: row.first_seen,
          lastSeen: row.last_seen,
        })
      : null;
  }
  function pairings(): PairingRecord[] {
    assertOpen();
    return db
      .prepare("SELECT * FROM pairings WHERE computer_fp = ? ORDER BY phone_fp")
      .all(fp)
      .map(pairingRecord);
  }
  function window(): PairingWindow | null {
    assertOpen();
    const row = db.prepare("SELECT * FROM pairing_window WHERE computer_fp = ?").get(fp);
    return row
      ? decodePairingWindow({
          gateHash: row.gate_hash,
          expiresAt: row.expires_at,
          admitted: row.admitted,
        })
      : null;
  }
  function pendingRevocations(): string[] {
    assertOpen();
    return db
      .prepare("SELECT phone_fp FROM pending_unpairs WHERE computer_fp = ? ORDER BY at, phone_fp")
      .all(fp)
      .map((row) => FpSchema.parse(row.phone_fp));
  }
  function upsert(record: PairingRecord) {
    db.prepare(`INSERT INTO pairings (computer_fp, phone_fp, ed25519_pub, pair_id, name, push_token, push_platform, push_provider, push_environment, push_enabled, paired_at, last_seen)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(computer_fp, phone_fp) DO UPDATE SET ed25519_pub = excluded.ed25519_pub, pair_id = excluded.pair_id, name = excluded.name`).run(
      fp,
      record.phoneFp,
      record.publicKey,
      record.pairId ?? null,
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
  function remove(phone: string) {
    for (const table of [
      "push_jobs",
      "push_accepted",
      "push_registrations",
      "pairings",
      "push_limits",
      "push_attempts",
    ] as const)
      db.prepare(`DELETE FROM ${table} WHERE computer_fp = ? AND phone_fp = ?`).run(fp, phone);
  }
  function clear() {
    for (const table of [
      "push_jobs",
      "push_accepted",
      "push_registrations",
      "push_attempts",
      "push_limits",
      "ring_limits",
      "pairing_window",
      "pending_unpairs",
      "pairings",
      "computer",
    ] as const)
      db.prepare(`DELETE FROM ${table} WHERE computer_fp = ?`).run(fp);
  }
  return {
    async computer() {
      return computer();
    },
    async pairings() {
      return pairings();
    },
    async pairing(phone) {
      assertOpen();
      FpSchema.parse(phone);
      const row = db
        .prepare("SELECT * FROM pairings WHERE computer_fp = ? AND phone_fp = ?")
        .get(fp, phone);
      return row ? pairingRecord(row) : null;
    },
    async window() {
      return window();
    },
    async pendingRevocations() {
      return pendingRevocations();
    },
    async pendingRevocationProofs() {
      assertOpen();
      return db
        .prepare(
          "SELECT proof FROM pending_unpairs WHERE computer_fp = ? AND proof IS NOT NULL ORDER BY at, phone_fp",
        )
        .all(fp)
        .map((row) => {
          if (!(row.proof instanceof Uint8Array)) {
            throw new ProtocolError("malformed", "invalid stored revocation proof");
          }
          return decodePairRevocationV2(row.proof);
        });
    },
    async acknowledgeRevocationProof(phone, pairId) {
      assertOpen();
      FpSchema.parse(phone);
      if (pairId.length !== 32) throw new ProtocolError("malformed", "invalid pair ID");
      return transaction(() => {
        const row = db
          .prepare("SELECT proof FROM pending_unpairs WHERE computer_fp = ? AND phone_fp = ?")
          .get(fp, phone);
        if (!row || !(row.proof instanceof Uint8Array)) return false;
        const proof = decodePairRevocationV2(row.proof);
        if (!bytesEqual(proof.pairId, pairId)) return false;
        db.prepare(
          "DELETE FROM pending_unpairs WHERE computer_fp = ? AND phone_fp = ? AND proof = ?",
        ).run(fp, phone, row.proof);
        return true;
      });
    },
    async registerComputer(value) {
      assertOpen();
      const row = validateRepositoryInput(() => {
        const input = decodeComputerRecord(value);
        if (input.fingerprint !== fp)
          throw new ProtocolError("malformed", "computer ownership mismatch");
        return input;
      });
      db.prepare(`INSERT INTO computer (computer_fp, ed25519_pub, name, first_seen, last_seen) VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(computer_fp) DO UPDATE SET name = excluded.name, last_seen = excluded.last_seen`).run(
        fp,
        row.publicKey,
        row.name,
        row.firstSeen,
        row.lastSeen,
      );
    },
    async openWindow(gateHash, expiresAt) {
      assertOpen();
      const row = validateRepositoryInput(() =>
        decodePairingWindow({ gateHash, expiresAt, admitted: 0 }),
      );
      db.prepare(`INSERT INTO pairing_window (computer_fp, gate_hash, expires_at, admitted) VALUES (?, ?, ?, 0)
        ON CONFLICT(computer_fp) DO UPDATE SET gate_hash = excluded.gate_hash, expires_at = excluded.expires_at, admitted = 0`).run(
        fp,
        row.gateHash,
        row.expiresAt,
      );
    },
    async closeWindow() {
      assertOpen();
      db.prepare("DELETE FROM pairing_window WHERE computer_fp = ?").run(fp);
    },
    async admitPairing(gateHash, now) {
      const gate = validateRepositoryInput(
        () => decodePairingWindow({ gateHash, expiresAt: now, admitted: 0 }).gateHash,
      );
      return transaction(() => {
        const current = window();
        if (!current || !bytesEqual(current.gateHash, gate)) return "closed";
        if (now >= current.expiresAt) return "expired";
        if (current.admitted >= MAX_PAIRING_ADMISSIONS) return "full";
        db.prepare("UPDATE pairing_window SET admitted = admitted + 1 WHERE computer_fp = ?").run(
          fp,
        );
        return "admitted";
      });
    },
    async addPairing(value, now) {
      const row = validateRepositoryInput(() => decodePairingRecord(value));
      identityTimestamp(now);
      return transaction(() => {
        if (pendingRevocations().includes(row.phoneFp)) return "revoked";
        const count = Number(
          db
            .prepare("SELECT COUNT(*) AS n FROM pairings WHERE computer_fp = ? AND phone_fp != ?")
            .get(fp, row.phoneFp)!.n,
        );
        if (count >= MAX_PAIRINGS) return "full";
        upsert(row);
        return "added";
      });
    },
    async revoke(phone, tombstone, now, proof) {
      FpSchema.parse(phone);
      identityTimestamp(now);
      if (proof && (proof.phoneFp !== phone || proof.computerFp !== fp)) {
        throw new ProtocolError("malformed", "revocation proof routing mismatch");
      }
      const encodedProof = proof ? encodePairRevocationV2(proof) : null;
      return transaction(() => {
        const pending = pendingRevocations();
        const canStore = tombstone && (pending.includes(phone) || pending.length < MAX_PAIRINGS);
        if (proof && !canStore) return false;
        remove(phone);
        if (canStore)
          db.prepare(
            `INSERT INTO pending_unpairs (computer_fp, phone_fp, at, proof) VALUES (?, ?, ?, ?)
           ON CONFLICT(computer_fp, phone_fp) DO UPDATE SET
             at = excluded.at, proof = COALESCE(excluded.proof, pending_unpairs.proof)`,
          ).run(fp, phone, now, encodedProof);
        return canStore;
      });
    },
    async syncPairings(values, now) {
      identityTimestamp(now);
      const rows = validateRepositoryInput(() => {
        if (values.length > MAX_PAIRINGS) throw new ProtocolError("malformed", "too many pairings");
        const input = values.map(decodePairingRecord);
        if (new Set(input.map((row) => row.phoneFp)).size !== input.length)
          throw new ProtocolError("malformed", "duplicate pairings");
        return input;
      });
      return transaction(() => {
        const revoked = pendingRevocations();
        const tombstones = new Set(revoked);
        const accepted = rows.filter((row) => !tombstones.has(row.phoneFp));
        const keep = new Set(accepted.map((row) => row.phoneFp));
        for (const phone of revoked) remove(phone);
        for (const row of pairings()) if (!keep.has(row.phoneFp)) remove(row.phoneFp);
        for (const row of accepted) upsert(row);
        db.prepare("DELETE FROM pending_unpairs WHERE computer_fp = ? AND proof IS NULL").run(fp);
        return revoked;
      });
    },
    async markSeen(now) {
      assertOpen();
      identityTimestamp(now);
      db.prepare("UPDATE computer SET last_seen = ? WHERE computer_fp = ?").run(now, fp);
    },
    async markPairingSeen(phone, now) {
      assertOpen();
      FpSchema.parse(phone);
      identityTimestamp(now);
      db.prepare("UPDATE pairings SET last_seen = ? WHERE computer_fp = ? AND phone_fp = ?").run(
        now,
        fp,
        phone,
      );
    },
    async deleteExpiredComputer(now) {
      identityTimestamp(now);
      return transaction(() => {
        const row = computer();
        if (!row || now - row.lastSeen <= GC_AFTER_MS) return false;
        clear();
        return true;
      });
    },
    async deleteOrphanedComputer() {
      return transaction(() => {
        if (computer()) return false;
        clear();
        return true;
      });
    },
  };
}
