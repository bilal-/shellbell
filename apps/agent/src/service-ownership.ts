import { canonicalDestination } from "./host-files.js";
import { NativeControllerError, type NativeErrorCode } from "./native/protocol.js";
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
  const record = inspectOwner(
    new ServiceOwnerStore({ ...options, stateDir: canonicalDestination(options.stateDir) }),
  );
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
 * children use the supervising parent's transaction instead; taking that
 * parent's lock again would deadlock readiness. */
export async function withHeadlessEngineAdmission<T>(
  options: { stateDir: string; uid: number },
  start: () => Promise<T>,
): Promise<T> {
  const store = new ServiceOwnerStore({
    ...options,
    stateDir: canonicalDestination(options.stateDir),
  });
  const before = inspectOwner(store);
  requireHeadless(before);
  return rethrowOperationError(store, before?.revision ?? null, async (tx) => {
    requireHeadless(tx.current);
    return start();
  });
}

/** Runs `operation` inside the ownership transaction. The private store reports any failure as
 * `operation-failed`; the operation's own error, such as "already running" or a rollback report,
 * is what the owner needs. Storage failures keep the store's own bounded errors. */
async function rethrowOperationError<T>(
  store: ServiceOwnerStore,
  revision: string | null,
  operation: (tx: OwnerTransaction) => Promise<T>,
): Promise<T> {
  let operationFailed = false,
    operationError: unknown;
  return store
    .mutate(revision, async (tx) => {
      try {
        return await operation(tx);
      } catch (error) {
        operationFailed = true;
        operationError = error;
        throw error;
      }
    })
    .catch((error) => {
      if (operationFailed) throw operationError;
      throw headlessStoreError(error);
    });
}

function inspectOwner(store: ServiceOwnerStore): OwnerRecord | null {
  try {
    return store.inspect();
  } catch (error) {
    throw headlessStoreError(error);
  }
}

/** The ownership record is shared with the Mac app, whose controller speaks in codes. The
 * headless CLI owner reads sentences; the `shellbell:` prefix is what the Linux CLI shows. */
function headlessStoreError(error: unknown): unknown {
  if (!(error instanceof NativeControllerError)) return error;
  const message: Partial<Record<NativeErrorCode, string>> = {
    busy: "shellbell: Another Shellbell change is in progress, such as the Mac app starting or stopping its service. Try again in a moment.",
    conflict:
      "shellbell: Shellbell's service ownership changed while this ran. Check `shellbell service status`, then try again.",
    "operation-failed":
      "shellbell: Shellbell couldn't read or save its service ownership record in its state folder. Check that the folder is yours and has free space, then try again.",
    "unsafe-state":
      "shellbell: Shellbell's state folder has unsafe permissions or ownership; it must belong to you and not be writable by others.",
  };
  return message[error.code] ? new Error(message[error.code]) : error;
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
  const before = inspectOwner(store);
  requireHeadless(before);
  if (!options.create && !before && !existsSync(options.stateDir)) return action();
  return rethrowOperationError(store, before?.revision ?? null, async (tx) => {
    requireHeadless(tx.current);
    const result = await action();
    const startupEnabled = options.startupPreference
      ? options.startupPreference(result)
      : result.startupEnabled;
    if (startupEnabled !== null && (result.installed || tx.current)) {
      if (!tx.current || tx.current.startupEnabled !== startupEnabled)
        try {
          tx.publish({ v: 1, mode: "headless", consented: true, startupEnabled, transition: null });
        } catch (error) {
          throw headlessStoreError(error);
        }
    }
    return result;
  });
}

import { existsSync } from "node:fs";
