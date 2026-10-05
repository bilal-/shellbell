import {
  decodePairRevocationV2,
  encodePairRevocationV2,
  fingerprint,
  fromBase64Url,
  type PairRevocationV2,
  toBase64Url,
} from "@shellbell/protocol";

const KEY = "shellbell.revocation-outbox.v2";
const MAX_PENDING = 32;
const MAX_JSON_BYTES = 32_768;

export interface PendingRevocation {
  proof: PairRevocationV2;
  phoneEd25519Pub: Uint8Array;
  relayUrl: string;
}

export interface RevocationStorage {
  getItemSync(key: string): string | null;
  setItemSync(key: string, value: string): void;
}

function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
  return a.length === b.length && a.every((byte, i) => byte === b[i]);
}

/** Proofs contain no K_pair, but must survive local key deletion and app restarts. */
export class RevocationOutbox {
  constructor(private readonly storage: RevocationStorage) {}

  list(): PendingRevocation[] {
    const raw = this.storage.getItemSync(KEY);
    if (raw === null) return [];
    if (raw.length > MAX_JSON_BYTES) throw new Error("revocation outbox is oversized");
    const rows: unknown = JSON.parse(raw);
    if (!Array.isArray(rows) || rows.length > MAX_PENDING) {
      throw new Error("invalid revocation outbox");
    }
    return rows.map((row) => {
      if (typeof row !== "object" || row === null || Array.isArray(row)) {
        throw new Error("invalid revocation outbox entry");
      }
      const value = row as Record<string, unknown>;
      if (
        typeof value.proof !== "string" ||
        typeof value.phoneEd25519Pub !== "string" ||
        typeof value.relayUrl !== "string" ||
        value.relayUrl.length < 1 ||
        value.relayUrl.length > 2048
      ) {
        throw new Error("invalid revocation outbox entry");
      }
      const proof = decodePairRevocationV2(fromBase64Url(value.proof));
      const phoneEd25519Pub = fromBase64Url(value.phoneEd25519Pub);
      if (phoneEd25519Pub.length !== 32 || fingerprint(phoneEd25519Pub) !== proof.phoneFp) {
        throw new Error("revocation outbox identity mismatch");
      }
      return { proof, phoneEd25519Pub, relayUrl: value.relayUrl };
    });
  }

  put(entry: PendingRevocation): void {
    // Round-trip through the bounded wire codec before touching durable state.
    const proof = decodePairRevocationV2(encodePairRevocationV2(entry.proof));
    if (
      entry.phoneEd25519Pub.length !== 32 ||
      fingerprint(entry.phoneEd25519Pub) !== proof.phoneFp ||
      entry.relayUrl.length < 1 ||
      entry.relayUrl.length > 2048
    ) {
      throw new Error("invalid revocation outbox entry");
    }
    const pending = this.list();
    const previous = pending.find(
      (row) =>
        row.proof.computerFp === proof.computerFp &&
        row.proof.phoneFp === proof.phoneFp &&
        sameBytes(row.proof.pairId, proof.pairId),
    );
    if (previous) {
      if (
        !sameBytes(previous.proof.signature, proof.signature) ||
        !sameBytes(previous.phoneEd25519Pub, entry.phoneEd25519Pub) ||
        previous.relayUrl !== entry.relayUrl
      ) {
        throw new Error("conflicting revocation outbox entry");
      }
      return;
    }
    if (pending.length >= MAX_PENDING) throw new Error("revocation outbox is full");
    this.write([
      ...pending,
      { proof, phoneEd25519Pub: entry.phoneEd25519Pub, relayUrl: entry.relayUrl },
    ]);
  }

  remove(phoneFp: string, computerFp: string, pairId: Uint8Array): void {
    const pending = this.list();
    const remaining = pending.filter(
      (row) =>
        row.proof.phoneFp !== phoneFp ||
        row.proof.computerFp !== computerFp ||
        !sameBytes(row.proof.pairId, pairId),
    );
    if (remaining.length !== pending.length) this.write(remaining);
  }

  private write(entries: PendingRevocation[]): void {
    const encoded = JSON.stringify(
      entries.map((entry) => ({
        proof: toBase64Url(encodePairRevocationV2(entry.proof)),
        phoneEd25519Pub: toBase64Url(entry.phoneEd25519Pub),
        relayUrl: entry.relayUrl,
      })),
    );
    if (encoded.length > MAX_JSON_BYTES) throw new Error("revocation outbox is oversized");
    this.storage.setItemSync(KEY, encoded);
  }
}
