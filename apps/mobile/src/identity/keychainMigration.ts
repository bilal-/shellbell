/**
 * One-time SecureStore hardening migration (spec 13 / review C1).
 *
 * Kept free of any `expo-secure-store` import so it can be unit-tested under plain vitest/node:
 * `expo-secure-store` pulls in `expo-modules-core` -> `react-native`, whose Flow-typed sources do
 * not load outside a real RN/Metro toolchain. `identity/keys.ts` wires this pure function to the
 * real SecureStore; tests wire it to an in-memory fake.
 */

export const KEYCHAIN_MIGRATION_MARKER = "shellbell.keychain.v2";

/** Deliberately loose (not `SecureStore.SecureStoreOptions`) so this file needs no expo import. */
export type SecureOptions = Record<string, unknown>;

export interface MigratableStore {
  getItemAsync(key: string): Promise<string | null>;
  setItemAsync(key: string, value: string, options: SecureOptions): Promise<void>;
}

/**
 * Rewrites every key in `keys` that currently holds a value under `secureOptions`, exactly once
 * per device: gated by `KEYCHAIN_MIGRATION_MARKER`, itself written under `secureOptions` last, so
 * an interrupted migration (crash mid-loop) simply retries on the next launch rather than
 * silently marking itself done. A missing key (never paired, or not yet created) is skipped.
 */
export async function migrateKeychainOnce(
  store: MigratableStore,
  keys: readonly string[],
  secureOptions: SecureOptions,
): Promise<void> {
  const marker = await store.getItemAsync(KEYCHAIN_MIGRATION_MARKER);
  if (marker) return;
  for (const key of keys) {
    const value = await store.getItemAsync(key);
    if (value !== null) await store.setItemAsync(key, value, secureOptions);
  }
  await store.setItemAsync(KEYCHAIN_MIGRATION_MARKER, "1", secureOptions);
}
