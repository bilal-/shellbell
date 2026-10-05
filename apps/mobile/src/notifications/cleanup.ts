export interface ComputerRemovalPorts {
  isCurrent(fp: string): boolean;
  markRemoving(fp: string): void;
  /** Persist the signed revocation proof before any key can be deleted. */
  prepareRevocation?(fp: string): Promise<void>;
  disconnect(fp: string): void;
  removeNative(fp: string): Promise<void>;
  deleteSecret(fp: string): Promise<void>;
  removeRecord(fp: string): void;
}

export class PairingConflictError extends Error {
  constructor() {
    super("Unpair this computer completely before pairing it again.");
  }
}

const mutations = new Map<string, Promise<unknown>>();
async function serialized<T>(fp: string, operation: () => Promise<T>): Promise<T> {
  const pending = (mutations.get(fp) ?? Promise.resolve()).catch(() => undefined).then(operation);
  mutations.set(fp, pending);
  try {
    return await pending;
  } finally {
    if (mutations.get(fp) === pending) mutations.delete(fp);
  }
}

/** Replacement must first finish unpairing. Never clear a revocation tombstone by upserting. */
export function commitNewPairing(
  fp: string,
  ports: {
    hasRecord(fp: string): boolean;
    writeSecret(fp: string): Promise<void>;
    addRecord(fp: string): void;
  },
): Promise<void> {
  return serialized(fp, async () => {
    if (ports.hasRecord(fp)) throw new PairingConflictError();
    await ports.writeSecret(fp);
    ports.addRecord(fp);
  });
}

/** The durable tombstone prevents reconnects while cleanup is pending, including after restart. */
export async function removePairedComputer(fp: string, ports: ComputerRemovalPorts): Promise<void> {
  return serialized(fp, async () => {
    const current = () => {
      if (!ports.isCurrent(fp)) throw new PairingConflictError();
    };
    current();
    ports.markRemoving(fp);
    await ports.prepareRevocation?.(fp);
    current();
    ports.disconnect(fp);
    await ports.removeNative(fp);
    current();
    await ports.deleteSecret(fp);
    current();
    ports.removeRecord(fp);
  });
}
