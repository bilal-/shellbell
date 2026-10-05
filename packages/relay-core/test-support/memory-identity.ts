import { bytesEqual, MAX_PAIRINGS, type PairRevocationV2 } from "@shellbell/protocol";
import type { IdentityStore } from "../src/ports/identity-store.js";
import type { ComputerRecord, PairingRecord, PairingWindow } from "../src/ports/models.js";

/** Domain fake: atomic operations, without copying the production SQL implementation. */
export class MemoryIdentity implements IdentityStore {
  record: ComputerRecord | null = null;
  phones = new Map<string, PairingRecord>();
  gate: PairingWindow | null = null;
  revoked = new Set<string>();
  revocationProofs = new Map<string, PairRevocationV2>();
  async computer() {
    return structuredClone(this.record);
  }
  async pairings() {
    return structuredClone([...this.phones.values()]);
  }
  async pairing(fp: string) {
    return structuredClone(this.phones.get(fp) ?? null);
  }
  async window() {
    return structuredClone(this.gate);
  }
  async pendingRevocations() {
    return [...this.revoked];
  }
  async pendingRevocationProofs() {
    return structuredClone(
      [...this.revocationProofs.entries()]
        .filter(([fp]) => this.revoked.has(fp))
        .map(([, proof]) => proof),
    );
  }
  async acknowledgeRevocationProof(fp: string, pairId: Uint8Array) {
    const proof = this.revocationProofs.get(fp);
    if (!proof || !bytesEqual(proof.pairId, pairId)) return false;
    this.revocationProofs.delete(fp);
    this.revoked.delete(fp);
    return true;
  }
  async registerComputer(record: ComputerRecord) {
    this.record = structuredClone(
      this.record ? { ...this.record, name: record.name, lastSeen: record.lastSeen } : record,
    );
  }
  async openWindow(gateHash: Uint8Array, expiresAt: number) {
    this.gate = { gateHash: new Uint8Array(gateHash), expiresAt, admitted: 0 };
  }
  async closeWindow() {
    this.gate = null;
  }
  async admitPairing(hash: Uint8Array, now: number) {
    if (!this.gate || !bytesEqual(hash, this.gate.gateHash)) return "closed" as const;
    if (now >= this.gate.expiresAt) return "expired" as const;
    if (this.gate.admitted >= 5) return "full" as const;
    this.gate.admitted++;
    return "admitted" as const;
  }
  async addPairing(record: PairingRecord, _now: number) {
    return this.addRecord(record);
  }
  private addRecord(record: PairingRecord) {
    if (this.revoked.has(record.phoneFp)) return "revoked" as const;
    const previous = this.phones.get(record.phoneFp);
    if (!previous && this.phones.size >= MAX_PAIRINGS) return "full" as const;
    this.phones.set(
      record.phoneFp,
      structuredClone(
        previous
          ? { ...previous, publicKey: record.publicKey, name: record.name, pairId: record.pairId }
          : record,
      ),
    );
    return "added" as const;
  }
  async revoke(fp: string, tombstone: boolean, _now: number, proof?: PairRevocationV2) {
    const canStore = tombstone && (this.revoked.has(fp) || this.revoked.size < MAX_PAIRINGS);
    if (proof && !canStore) return false;
    this.phones.delete(fp);
    if (canStore) {
      this.revoked.add(fp);
      if (proof) this.revocationProofs.set(fp, structuredClone(proof));
    } else if (!tombstone) {
      this.revocationProofs.delete(fp);
    }
    return canStore;
  }
  async syncPairings(records: readonly PairingRecord[], _now: number) {
    const revoked = [...this.revoked];
    const keep = new Set(records.map((p) => p.phoneFp));
    for (const fp of this.phones.keys()) if (!keep.has(fp)) this.phones.delete(fp);
    for (const record of records) this.addRecord(record);
    for (const fp of revoked) if (!this.revocationProofs.has(fp)) this.revoked.delete(fp);
    return revoked;
  }
  async markSeen(now: number) {
    if (this.record) this.record.lastSeen = now;
  }
  async markPairingSeen(fp: string, now: number) {
    const p = this.phones.get(fp);
    if (p) p.lastSeenAt = now;
  }
  async deleteExpiredComputer(now: number) {
    if (!this.record || now - this.record.lastSeen <= 90 * 24 * 3600 * 1000) return false;
    this.record = null;
    this.phones.clear();
    this.revoked.clear();
    this.revocationProofs.clear();
    this.gate = null;
    return true;
  }
  async deleteOrphanedComputer() {
    if (this.record) return false;
    this.phones.clear();
    this.revoked.clear();
    this.revocationProofs.clear();
    this.gate = null;
    return true;
  }
}
