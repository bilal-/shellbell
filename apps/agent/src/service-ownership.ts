import { canonicalDestination } from "./host-files.js";
import { PrivateRecordStore, type PrivateRecordTransaction } from "./private-record-store.js";
import { type OwnerRecord, OwnerRecordSchema } from "./service-ownership-schema.js";

export * from "./service-ownership-schema.js";
export type OwnerTransaction = PrivateRecordTransaction<OwnerRecord>;
export class ServiceOwnerStore extends PrivateRecordStore<OwnerRecord> {
  constructor(options: { stateDir: string; uid: number }) {
    super({
      root: options.stateDir,
      uid: options.uid,
      filename: "service-owner.json",
      maxBytes: 16 * 1024,
      schema: OwnerRecordSchema,
    });
  }
}
function requireHeadless(record: OwnerRecord | null): void {
  if (record?.mode === "desktop")
    throw new Error(
      "Service is desktop-owned; use Shellbell or explicitly convert it to headless mode",
    );
  if (record?.transition)
    throw new Error(
      "An ownership conversion needs explicit recovery before headless service changes",
    );
}
/** Fixed lock order: host/user ownership, then the platform manager guard. */
export function requireHeadlessEngine(options: {
  stateDir: string;
  uid: number;
  serviceInstance?: string | null;
}): void {
  const record = new ServiceOwnerStore({
    ...options,
    stateDir: canonicalDestination(options.stateDir),
  }).inspect();
  const intent = record?.transition;
  // The conversion UUID is the exact new headless runtime instance. Ordinary
  // CLI/foreground starts cannot pass through a pending conversion.
  if (
    record?.mode === "headless" &&
    intent?.target === "headless" &&
    options.serviceInstance === intent.id &&
    ["source-stopped", "destination-started"].includes(intent.phase)
  )
    return;
  requireHeadless(record);
}

/** Foreground contenders hold ownership through endpoint publication. Managed
 * children use their instance-bound parent transaction instead; taking that
 * parent's lock again would deadlock readiness. */
export async function withHeadlessEngineAdmission<T>(
  options: { stateDir: string; uid: number },
  start: () => Promise<T>,
): Promise<T> {
  const store = new ServiceOwnerStore({
    ...options,
    stateDir: canonicalDestination(options.stateDir),
  });
  const before = store.inspect();
  requireHeadless(before);
  return store.mutate(before?.revision ?? null, async (tx) => {
    requireHeadless(tx.current);
    return start();
  });
}

export async function withHeadlessOwnership<
  T extends { installed: boolean; startupEnabled: boolean | null },
>(
  options: {
    stateDir: string;
    uid: number;
    create: boolean;
    startupPreference?: (result: T) => boolean | null;
  },
  action: () => Promise<T>,
): Promise<T> {
  const store = new ServiceOwnerStore(options);
  const before = store.inspect();
  requireHeadless(before);
  if (!options.create && !before && !existsSync(options.stateDir)) return action();
  let operationFailed = false,
    operationError: unknown;
  return store
    .mutate(before?.revision ?? null, async (tx) => {
      requireHeadless(tx.current);
      let result: T;
      try {
        result = await action();
      } catch (error) {
        operationFailed = true;
        operationError = error;
        throw error;
      }
      const startupEnabled = options.startupPreference
        ? options.startupPreference(result)
        : result.startupEnabled;
      if (startupEnabled !== null && (result.installed || tx.current)) {
        if (!tx.current || tx.current.startupEnabled !== startupEnabled)
          tx.publish({ v: 1, mode: "headless", consented: true, startupEnabled, transition: null });
      }
      return result;
    })
    .catch((error) => {
      // Keep the platform lifecycle's structured rollback report; storage failures
      // themselves retain the private store's bounded admission errors.
      if (operationFailed) throw operationError;
      throw error;
    });
}

import { existsSync } from "node:fs";
