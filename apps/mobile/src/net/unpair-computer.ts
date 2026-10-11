import { createPairRevocationV2 } from "@shellbell/protocol";
import {
  deletePairSecret,
  loadExistingIdentity,
  loadPairSecret,
  migrateStoredKeys,
} from "../identity/keys";
import { dismissComputerNotifications, kvTitleStorage } from "../notifications";
import { removePairedComputer } from "../notifications/cleanup";
import { nativeNotifications, nativeNotificationsAvailable } from "../notifications/native";
import { evictUnpairedComputers } from "../notifications/sessionTitles";
import type { Computer } from "../store/computers";
import { useComputersStore } from "../store/computers";
import { connectionManager } from "./manager";
import { durableRevocationOutbox, retryPendingRevocations } from "./revocation-retry";

/** Unpairs `computer` here, keeping the revocation proof and tombstone until cleanup finishes. */
export async function unpairComputer(computer: Computer): Promise<void> {
  const { fp } = computer;
  const { update, remove } = useComputersStore.getState();
  const connection = connectionManager.get(fp);
  // Best-effort (spec 10.8 / review R60): tell the relay/agent before wiping local
  // state, so the Mac forgets this phone too when it's reachable. Local state is wiped
  // either way -- this phone is unpaired here regardless of whether the send lands.
  await removePairedComputer(fp, {
    isCurrent: () => {
      const current = useComputersStore.getState().computers.find((c) => c.fp === fp);
      return (
        !!current &&
        (current.pairingId ?? current.pairedAt) === (computer.pairingId ?? computer.pairedAt)
      );
    },
    markRemoving: () => {
      try {
        // The store's removal observer closes this socket synchronously.
        connection?.unpairSelf();
      } finally {
        update(fp, { removing: true });
      }
    },
    prepareRevocation: async () => {
      const pairedFps = useComputersStore.getState().computers.map((c) => c.fp);
      await migrateStoredKeys(pairedFps);
      const secret = await loadPairSecret(fp);
      if (secret?.minProtocolVersion !== 2) return;
      const { identity, fp: phoneFp } = await loadExistingIdentity(pairedFps);
      const proof = createPairRevocationV2({
        computerFp: fp,
        phoneFp,
        kPair: secret.kPair,
        phoneEd25519Priv: identity.ed25519.priv,
        phoneEd25519Pub: identity.ed25519.pub,
      });
      durableRevocationOutbox().put({
        proof,
        phoneEd25519Pub: identity.ed25519.pub,
        relayUrl: computer.relayUrl,
      });
      void retryPendingRevocations().catch(() => undefined);
    },
    disconnect: () => {
      connection?.close("user");
    },
    removeNative: async () => {
      if (nativeNotificationsAvailable) await nativeNotifications.removeNotificationComputer(fp);
      await dismissComputerNotifications(fp);
    },
    deleteSecret: deletePairSecret,
    removeRecord: remove,
  });
  // Spec §5 / review Minor: an unpaired computer's session titles must not linger in
  // kv-store forever.
  evictUnpairedComputers(
    useComputersStore.getState().computers.map((c) => c.fp),
    kvTitleStorage,
  );
}
