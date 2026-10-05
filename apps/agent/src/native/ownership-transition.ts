import type { OwnershipIntent, OwnershipPhase, OwnerTransaction } from "../service-ownership.js";
/** Called only inside host-owner -> native-record -> manager guards. Each adapter
 * must re-observe its manager and endpoint; phases are recovery intent, not proof.
 */
export async function runOwnershipTransition(
  tx: OwnerTransaction,
  intent: OwnershipIntent,
  steps: {
    preflight(): Promise<void>;
    stopSource(): Promise<void>;
    verifyAbsent(): Promise<void>;
    startDestination(): Promise<void>;
    complete(): Promise<void>;
  },
): Promise<void> {
  await steps.preflight();
  const phase = (value: OwnershipPhase) =>
    tx.publish({
      v: 1,
      mode: value === "prepared" ? (tx.current?.mode ?? intent.target) : intent.target,
      consented: true,
      startupEnabled: tx.current?.startupEnabled ?? false,
      transition: { ...intent, phase: value },
    });
  if (!tx.current?.transition) phase("prepared");
  try {
    await steps.stopSource();
    await steps.verifyAbsent();
    phase("source-stopped");
    await steps.startDestination();
    phase("destination-started");
    await steps.complete();
    tx.publish({
      v: 1,
      mode: intent.target,
      consented: true,
      startupEnabled: tx.current!.startupEnabled,
      transition: null,
    });
  } catch (error) {
    phase("recovery-required");
    throw error;
  }
}
