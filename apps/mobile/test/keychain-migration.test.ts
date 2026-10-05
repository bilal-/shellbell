import { describe, expect, it } from "vitest";
import {
  KEYCHAIN_MIGRATION_MARKER,
  migrateKeychainOnce,
  type SecureOptions,
} from "../src/identity/keychainMigration";

class FakeStore {
  data = new Map<string, string>();
  setCalls: { key: string; value: string; options: SecureOptions }[] = [];
  async getItemAsync(key: string): Promise<string | null> {
    return this.data.get(key) ?? null;
  }
  async setItemAsync(key: string, value: string, options: SecureOptions): Promise<void> {
    this.data.set(key, value);
    this.setCalls.push({ key, value, options });
  }
}

const OPTS: SecureOptions = { keychainAccessible: "WHEN_UNLOCKED_THIS_DEVICE_ONLY" };

describe("migrateKeychainOnce", () => {
  it("rewrites every existing key under the secure options and then sets the marker", async () => {
    const store = new FakeStore();
    store.data.set("shellbell.identity.v1", "id-json");
    store.data.set("shellbell.pair.abc", "pair-json");
    await migrateKeychainOnce(store, ["shellbell.identity.v1", "shellbell.pair.abc"], OPTS);
    expect(store.setCalls.map((c) => c.key)).toEqual([
      "shellbell.identity.v1",
      "shellbell.pair.abc",
      KEYCHAIN_MIGRATION_MARKER,
    ]);
    for (const c of store.setCalls) expect(c.options).toBe(OPTS);
    expect(store.data.get(KEYCHAIN_MIGRATION_MARKER)).toBe("1");
  });

  it("skips a key that has no stored value", async () => {
    const store = new FakeStore();
    store.data.set("shellbell.identity.v1", "id-json");
    await migrateKeychainOnce(store, ["shellbell.identity.v1", "shellbell.pair.missing"], OPTS);
    expect(store.setCalls.map((c) => c.key)).toEqual([
      "shellbell.identity.v1",
      KEYCHAIN_MIGRATION_MARKER,
    ]);
  });

  it("is a one-time migration: a marker already present skips every rewrite", async () => {
    const store = new FakeStore();
    store.data.set(KEYCHAIN_MIGRATION_MARKER, "1");
    store.data.set("shellbell.identity.v1", "id-json");
    await migrateKeychainOnce(store, ["shellbell.identity.v1"], OPTS);
    expect(store.setCalls).toEqual([]);
  });

  it("running it twice only migrates once", async () => {
    const store = new FakeStore();
    store.data.set("shellbell.identity.v1", "id-json");
    await migrateKeychainOnce(store, ["shellbell.identity.v1"], OPTS);
    const callsAfterFirst = store.setCalls.length;
    await migrateKeychainOnce(store, ["shellbell.identity.v1"], OPTS);
    expect(store.setCalls.length).toBe(callsAfterFirst);
  });

  it("no keys ever existed: still sets the marker so a later cold start doesn't rescan", async () => {
    const store = new FakeStore();
    await migrateKeychainOnce(store, ["shellbell.identity.v1"], OPTS);
    expect(store.data.get(KEYCHAIN_MIGRATION_MARKER)).toBe("1");
  });
});
