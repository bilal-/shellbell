import { createPairRevocationV2 } from "@shellbell/protocol";
import { useLocalSearchParams, useRouter } from "expo-router";
import { useState } from "react";
import { Alert, Pressable, ScrollView, Switch, Text, View } from "react-native";
import { RelaySetting } from "../../../src/components/RelaySetting";
import {
  deletePairSecret,
  loadExistingIdentity,
  loadPairSecret,
  migrateStoredKeys,
} from "../../../src/identity/keys";
import { connectionManager } from "../../../src/net/manager";
import {
  durableRevocationOutbox,
  retryPendingRevocations,
} from "../../../src/net/revocation-retry";
import { dismissComputerNotifications, kvTitleStorage } from "../../../src/notifications";
import { removePairedComputer } from "../../../src/notifications/cleanup";
import {
  nativeNotifications,
  nativeNotificationsAvailable,
} from "../../../src/notifications/native";
import { evictUnpairedComputers } from "../../../src/notifications/sessionTitles";
import { useComputersStore } from "../../../src/store/computers";
import { useConnectionsStore } from "../../../src/store/connections";
import { tokens } from "../../../src/theme/tokens";
import { activeBackends, backendLabel } from "../../../src/util/backends";

const ACCENT_KEYS = Object.keys(tokens.accents) as (keyof typeof tokens.accents)[];

export default function ComputerSettings() {
  const [removing, setRemoving] = useState(false);
  const { fp } = useLocalSearchParams<{ fp: string }>();
  const router = useRouter();
  const computer = useComputersStore((s) => s.computers.find((c) => c.fp === fp));
  const update = useComputersStore((s) => s.update);
  const remove = useComputersStore((s) => s.remove);
  const conn = useConnectionsStore((s) => s.byComputer[fp ?? ""]);
  const backends = activeBackends(conn?.hello);

  if (!fp || !computer) return null;

  const unpair = () => {
    Alert.alert(
      "Unpair this computer?",
      "You can re-pair any time by scanning its QR code again.",
      [
        { text: "Cancel", style: "cancel" },
        {
          text: "Unpair",
          style: "destructive",
          onPress: async () => {
            if (removing) return;
            setRemoving(true);
            const connection = connectionManager.get(fp);
            try {
              // Best-effort (spec 10.8 / review R60): tell the relay/agent before wiping local
              // state, so the Mac forgets this phone too when it's reachable. Local state is wiped
              // either way -- this phone is unpaired here regardless of whether the send lands.
              await removePairedComputer(fp, {
                isCurrent: () => {
                  const current = useComputersStore.getState().computers.find((c) => c.fp === fp);
                  return (
                    !!current &&
                    (current.pairingId ?? current.pairedAt) ===
                      (computer.pairingId ?? computer.pairedAt)
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
                  if (nativeNotificationsAvailable)
                    await nativeNotifications.removeNotificationComputer(fp);
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
              router.replace("/");
            } catch {
              Alert.alert(
                "Could not finish unpairing",
                "This computer will stay disconnected. Tap Finish unpairing to retry local cleanup.",
              );
            } finally {
              setRemoving(false);
            }
          },
        },
      ],
    );
  };

  return (
    <ScrollView
      style={{ flex: 1, backgroundColor: tokens.bg }}
      contentContainerStyle={{ padding: 16, gap: 24 }}
      contentInsetAdjustmentBehavior="automatic"
    >
      <View style={{ gap: 4 }}>
        <Text style={{ color: tokens.textMuted, fontSize: 12, letterSpacing: 1 }}>COMPUTER</Text>
        <Text style={{ color: tokens.text, fontSize: 17 }}>{computer.name}</Text>
      </View>

      {backends.length > 0 ? (
        <View style={{ gap: 8 }}>
          <Text style={{ color: tokens.textMuted, fontSize: 12, letterSpacing: 1 }}>BACKENDS</Text>
          <View style={{ flexDirection: "row", gap: 8, flexWrap: "wrap" }}>
            {backends.map((b) => (
              <View
                key={b.name}
                style={{
                  borderWidth: 1,
                  borderColor: tokens.border,
                  borderRadius: 999,
                  paddingHorizontal: 10,
                  paddingVertical: 4,
                }}
              >
                <Text style={{ color: tokens.text, fontSize: 13 }}>
                  {backendLabel(b.name, conn?.hello?.backendCatalog)}
                </Text>
              </View>
            ))}
          </View>
        </View>
      ) : null}

      <RelaySetting key={fp} fp={fp} relayUrl={computer.relayUrl} />

      <View style={{ gap: 8 }}>
        <Text style={{ color: tokens.textMuted, fontSize: 12, letterSpacing: 1 }}>ACCENT</Text>
        <View style={{ flexDirection: "row", gap: 10, flexWrap: "wrap" }}>
          {ACCENT_KEYS.map((key) => (
            <Pressable
              key={key}
              accessibilityLabel={`Accent ${key}`}
              onPress={() => update(fp, { accent: key })}
              style={{
                width: 32,
                height: 32,
                borderRadius: 16,
                backgroundColor: tokens.accents[key],
                borderWidth: computer.accent === key ? 3 : 0,
                borderColor: tokens.text,
              }}
            />
          ))}
        </View>
      </View>

      <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between" }}>
        <Text style={{ color: tokens.text, fontSize: 15 }}>Notifications for this computer</Text>
        <Switch
          accessibilityLabel="Notifications for this computer"
          value={computer.pushEnabled}
          onValueChange={(v) => {
            update(fp, { pushEnabled: v });
            connectionManager.notifyPushToggle(fp, v);
          }}
        />
      </View>

      <View style={{ gap: 8 }}>
        <Pressable
          onPress={unpair}
          disabled={removing}
          style={{
            backgroundColor: tokens.surface2,
            borderColor: tokens.accents.rose,
            borderWidth: 1,
            borderRadius: tokens.radius.md,
            paddingVertical: 12,
            alignItems: "center",
          }}
        >
          <Text style={{ color: tokens.accents.rose, fontSize: 15 }}>
            {removing ? "Removing…" : computer.removing ? "Finish unpairing" : "Unpair"}
          </Text>
        </Pressable>
        <Text style={{ color: tokens.textFaint, fontSize: 12 }}>
          Removes this computer and its notification keys from this phone. If the computer is
          unreachable, also remove this phone with `shellbell unpair` there.
        </Text>
      </View>
    </ScrollView>
  );
}
