import {
  fingerprint,
  fromBase64Url,
  generateIdentity,
  type Identity,
  identityFromJson,
  identityToJson,
  toBase64Url,
} from "@shellbell/protocol";
import * as SecureStore from "expo-secure-store";
import { migrateKeychainOnce } from "./keychainMigration";

const ID_KEY = "shellbell.identity.v1";
const pairKey = (fp: string) => `shellbell.pair.${fp}`;

// Review C1: without this, `WHEN_UNLOCKED` (the SecureStore default) lets both the identity seed
// and every K_pair leave the device in an encrypted backup and land on a restored/second device,
// contrary to spec 6.2/13. Reads intentionally pass no options -- the accessibility attribute
// only gates storage/backup behaviour, not query matching, so an item written under the old
// default is still found.
const SECURE_OPTS: SecureStore.SecureStoreOptions = {
  keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY,
};

/**
 * Loads (or creates) the phone's Ed25519 identity. `pairedFps`, when the caller already knows the
 * paired-computer list (the root layout does, right after hydrating the computers store), lets
 * the one-time keychain migration (review C1) also cover every `K_pair` on this same pass; callers
 * without that context (settings, pairing) still cover the identity key itself, and the migration
 * is a no-op everywhere after the first successful run (gated by a marker, see
 * `keychainMigration.ts`).
 */
export async function loadOrCreateIdentity(
  pairedFps: readonly string[] = [],
): Promise<{ identity: Identity; fp: string }> {
  await migrateStoredKeys(pairedFps);
  const raw = await SecureStore.getItemAsync(ID_KEY);
  let identity: Identity;
  if (raw) {
    identity = identityFromJson(JSON.parse(raw));
  } else {
    identity = generateIdentity();
    await SecureStore.setItemAsync(ID_KEY, JSON.stringify(identityToJson(identity)), SECURE_OPTS);
  }
  return { identity, fp: fingerprint(identity.ed25519.pub) };
}

/** Revocation must never silently mint a different phone identity. */
export async function loadExistingIdentity(
  pairedFps: readonly string[] = [],
): Promise<{ identity: Identity; fp: string }> {
  await migrateStoredKeys(pairedFps);
  const raw = await SecureStore.getItemAsync(ID_KEY);
  if (!raw) throw new Error("phone identity missing; cannot sign pair revocation");
  const identity = identityFromJson(JSON.parse(raw));
  return { identity, fp: fingerprint(identity.ed25519.pub) };
}

/** Complete legacy keychain migration before reading a secret for destructive cleanup. */
export async function migrateStoredKeys(pairedFps: readonly string[]): Promise<void> {
  await migrateKeychainOnce(
    SecureStore,
    [ID_KEY, ...pairedFps.map(pairKey)],
    SECURE_OPTS as Record<string, unknown>,
  );
}

export interface PairSecret {
  kPair: Uint8Array;
  computerEd25519Pub: Uint8Array;
  computerX25519Pub: Uint8Array;
  /** Absent for a legacy pair; raised only after a confirmed v2 session. */
  minProtocolVersion?: 2;
}

const pairWrites = new Map<string, Promise<void>>();

function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
  return a.length === b.length && a.every((byte, i) => byte === b[i]);
}

function withPairWrite<T>(computerFp: string, write: () => Promise<T>): Promise<T> {
  const previous = pairWrites.get(computerFp) ?? Promise.resolve();
  const result = previous.then(write);
  const settled = result.then(
    () => {},
    () => {},
  );
  pairWrites.set(computerFp, settled);
  void settled.then(() => {
    if (pairWrites.get(computerFp) === settled) pairWrites.delete(computerFp);
  });
  return result;
}

async function writePairSecret(computerFp: string, s: PairSecret): Promise<void> {
  const json = JSON.stringify({
    kPair: toBase64Url(s.kPair),
    e: toBase64Url(s.computerEd25519Pub),
    x: toBase64Url(s.computerX25519Pub),
    ...(s.minProtocolVersion === 2 && { minProtocolVersion: 2 }),
  });
  await SecureStore.setItemAsync(pairKey(computerFp), json, SECURE_OPTS);
}

export function savePairSecret(computerFp: string, s: PairSecret): Promise<void> {
  return withPairWrite(computerFp, async () => {
    const previous = await loadPairSecret(computerFp);
    if (previous && sameBytes(previous.kPair, s.kPair)) {
      if (
        !sameBytes(previous.computerEd25519Pub, s.computerEd25519Pub) ||
        !sameBytes(previous.computerX25519Pub, s.computerX25519Pub)
      ) {
        throw new Error("pairing identity changed without a new pairing key");
      }
      if (previous.minProtocolVersion === 2) s = { ...s, minProtocolVersion: 2 };
    }
    await writePairSecret(computerFp, s);
  });
}

/** Commit the downgrade floor for the exact confirmed K_pair before using v2. */
export function upgradePairProtocolFloor(
  computerFp: string,
  expectedKPair: Uint8Array,
): Promise<void> {
  return withPairWrite(computerFp, async () => {
    const current = await loadPairSecret(computerFp);
    if (!current || !sameBytes(current.kPair, expectedKPair)) {
      throw new Error("pairing changed before protocol upgrade");
    }
    if (current.minProtocolVersion !== 2) {
      await writePairSecret(computerFp, { ...current, minProtocolVersion: 2 });
    }
  });
}

export async function loadPairSecret(computerFp: string): Promise<PairSecret | null> {
  const raw = await SecureStore.getItemAsync(pairKey(computerFp));
  if (!raw) return null;
  const j = JSON.parse(raw) as {
    kPair: string;
    e: string;
    x: string;
    minProtocolVersion?: unknown;
  };
  if (j.minProtocolVersion !== undefined && j.minProtocolVersion !== 2) {
    throw new Error("invalid stored minimum protocol version");
  }
  return {
    kPair: fromBase64Url(j.kPair),
    computerEd25519Pub: fromBase64Url(j.e),
    computerX25519Pub: fromBase64Url(j.x),
    ...(j.minProtocolVersion === 2 && { minProtocolVersion: 2 as const }),
  };
}

export function deletePairSecret(computerFp: string): Promise<void> {
  return withPairWrite(computerFp, () => SecureStore.deleteItemAsync(pairKey(computerFp)));
}
