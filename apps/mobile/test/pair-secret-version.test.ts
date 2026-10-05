import { beforeEach, describe, expect, it, vi } from "vitest";

const stored = vi.hoisted(() => new Map<string, string>());
vi.mock("expo-secure-store", () => ({
  WHEN_UNLOCKED_THIS_DEVICE_ONLY: "WHEN_UNLOCKED_THIS_DEVICE_ONLY",
  getItemAsync: vi.fn(async (key: string) => stored.get(key) ?? null),
  setItemAsync: vi.fn(async (key: string, value: string) => {
    stored.set(key, value);
  }),
  deleteItemAsync: vi.fn(async (key: string) => {
    stored.delete(key);
  }),
}));

import {
  loadExistingIdentity,
  loadPairSecret,
  savePairSecret,
  upgradePairProtocolFloor,
} from "../src/identity/keys";

const fp = "computer-fingerprint";
const secret = {
  kPair: new Uint8Array(32).fill(1),
  computerEd25519Pub: new Uint8Array(32).fill(2),
  computerX25519Pub: new Uint8Array(32).fill(3),
};

describe("per-pair protocol floor in SecureStore", () => {
  beforeEach(() => stored.clear());

  it("does not mint a replacement phone identity during revocation", async () => {
    await expect(loadExistingIdentity([fp])).rejects.toThrow(/identity missing/i);
    expect(stored.has("shellbell.identity.v1")).toBe(false);
  });

  it("loads legacy records and persists the v2 floor with the pair secret", async () => {
    await savePairSecret(fp, secret);
    expect((await loadPairSecret(fp))?.minProtocolVersion).toBeUndefined();
    await upgradePairProtocolFloor(fp, secret.kPair);
    expect((await loadPairSecret(fp))?.minProtocolVersion).toBe(2);
  });

  it("does not downgrade the same pairing when saved again", async () => {
    await savePairSecret(fp, { ...secret, minProtocolVersion: 2 });
    await savePairSecret(fp, secret);
    expect((await loadPairSecret(fp))?.minProtocolVersion).toBe(2);
  });

  it("allows a new QR pairing key to reset the floor", async () => {
    await savePairSecret(fp, { ...secret, minProtocolVersion: 2 });
    await savePairSecret(fp, { ...secret, kPair: new Uint8Array(32).fill(4) });
    expect((await loadPairSecret(fp))?.minProtocolVersion).toBeUndefined();
  });

  it("refuses a stale key upgrade and malformed stored floor", async () => {
    await savePairSecret(fp, secret);
    await expect(upgradePairProtocolFloor(fp, new Uint8Array(32))).rejects.toThrow();
    const key = `shellbell.pair.${fp}`;
    stored.set(key, JSON.stringify({ ...JSON.parse(stored.get(key)!), minProtocolVersion: 1 }));
    await expect(loadPairSecret(fp)).rejects.toThrow(/protocol version/i);
  });
});
