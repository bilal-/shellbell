import type { PairRevocationV2 } from "@shellbell/protocol";
import type { ComputerRecord, PairingRecord, PairingWindow } from "./models.js";

/** One computer's identity repository. Each mutation owns its complete atomic invariant. */
export interface IdentityStore {
  computer(): Promise<ComputerRecord | null>;
  pairings(): Promise<readonly PairingRecord[]>;
  pairing(phoneFp: string): Promise<PairingRecord | null>;
  window(): Promise<PairingWindow | null>;
  /** Non-destructive handshake read; syncPairings acknowledges these tombstones. */
  pendingRevocations(): Promise<readonly string[]>;
  /** Proofs only for still-pending tombstones; never trusted without service verification. */
  pendingRevocationProofs(): Promise<readonly PairRevocationV2[]>;
  /** Ack only the matching proof; a newer pair's tombstone must survive. */
  acknowledgeRevocationProof(phoneFp: string, pairId: Uint8Array): Promise<boolean>;
  registerComputer(record: ComputerRecord): Promise<void>;
  openWindow(gateHash: Uint8Array, expiresAt: number): Promise<void>;
  closeWindow(): Promise<void>;
  admitPairing(
    gateHash: Uint8Array,
    now: number,
  ): Promise<"admitted" | "closed" | "expired" | "full">;
  /** Updates metadata while preserving an existing pairing's push settings and timestamps. */
  addPairing(record: PairingRecord, now: number): Promise<"added" | "full" | "revoked">;
  /** Includes registration, queued jobs, legacy limits and attempts for this phone. */
  /** True iff a requested tombstone was durably stored; signed overflow keeps pairing intact. */
  revoke(
    phoneFp: string,
    tombstone: boolean,
    now: number,
    proof?: PairRevocationV2,
  ): Promise<boolean>;
  /** Apply tombstones before import, preserve retained settings, and return acknowledged tombstones. */
  syncPairings(records: readonly PairingRecord[], now: number): Promise<readonly string[]>;
  markSeen(now: number): Promise<void>;
  /** Successful phone authentication updates activity, never creates a pairing. */
  markPairingSeen(phoneFp: string, now: number): Promise<void>;
  /** Caller checks agent presence first; expire strictly after ninety days without activity. */
  deleteExpiredComputer(now: number): Promise<boolean>;
  /** Clear all residual metadata atomically, only if no computer row exists. */
  deleteOrphanedComputer(): Promise<boolean>;
}
