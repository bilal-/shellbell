import {
  createPairRevocationV2,
  fingerprint,
  generateIdentity,
  randomBytes,
} from "@shellbell/protocol";
import { describe, expect, it } from "vitest";
import { RevocationOutbox } from "../src/identity/revocation-outbox";

function fixture(phone = generateIdentity(), computer = generateIdentity()) {
  const kPair = randomBytes(32);
  const proof = createPairRevocationV2({
    computerFp: fingerprint(computer.ed25519.pub),
    phoneFp: fingerprint(phone.ed25519.pub),
    kPair,
    phoneEd25519Priv: phone.ed25519.priv,
    phoneEd25519Pub: phone.ed25519.pub,
  });
  return {
    proof,
    phoneEd25519Pub: phone.ed25519.pub,
    relayUrl: "wss://relay.example.test",
    phone,
    computer,
  };
}

function memoryStorage() {
  const rows = new Map<string, string>();
  return {
    getItemSync: (key: string) => rows.get(key) ?? null,
    setItemSync: (key: string, value: string) => {
      rows.set(key, value);
    },
  };
}

describe("durable revocation outbox", () => {
  it("restores a signed proof after restart and removes only its exact pair ID", () => {
    const storage = memoryStorage();
    const first = new RevocationOutbox(storage);
    const old = fixture();
    const newer = fixture(old.phone, old.computer);
    first.put(old);
    first.put(newer);
    const restarted = new RevocationOutbox(storage);
    expect(restarted.list()).toHaveLength(2);
    restarted.remove(old.proof.phoneFp, old.proof.computerFp, old.proof.pairId);
    expect(restarted.list()).toEqual([
      {
        proof: newer.proof,
        phoneEd25519Pub: newer.phoneEd25519Pub,
        relayUrl: newer.relayUrl,
      },
    ]);
  });
  it("does not discard an existing proof if persistence fails", () => {
    const storage = memoryStorage();
    const outbox = new RevocationOutbox(storage);
    const first = fixture();
    outbox.put(first);
    storage.setItemSync = () => {
      throw new Error("disk full");
    };
    expect(() => outbox.put(fixture())).toThrow("disk full");
    expect(outbox.list()).toEqual([
      {
        proof: first.proof,
        phoneEd25519Pub: first.phoneEd25519Pub,
        relayUrl: first.relayUrl,
      },
    ]);
  });
  it("rejects malformed or oversized persisted records rather than silently losing them", () => {
    const storage = memoryStorage();
    storage.setItemSync("shellbell.revocation-outbox.v2", "not json");
    expect(() => new RevocationOutbox(storage).list()).toThrow();
  });
});
