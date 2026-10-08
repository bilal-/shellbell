import { randomBytes, toBase64Url } from "@shellbell/protocol";
import { CameraView, useCameraPermissions } from "expo-camera";
import Constants from "expo-constants";
import * as Device from "expo-device";
import * as Haptics from "expo-haptics";
import { useRouter } from "expo-router";
import { useEffect, useRef, useState } from "react";
import { Alert, AppState, Linking, Platform, Pressable, Text, View } from "react-native";
import { loadOrCreateIdentity, savePairSecret } from "../src/identity/keys";
import { type PairingCode, PairingError, parsePairingQr, runPairing } from "../src/net/pairing";
import { ScanGuard } from "../src/net/scan-guard";
import { registerPushTokenWhenConnected, requestPermissionOnce } from "../src/notifications";
import { commitNewPairing, PairingConflictError } from "../src/notifications/cleanup";
import { useComputersStore } from "../src/store/computers";
import { tokens } from "../src/theme/tokens";

const COPY: Record<PairingCode, string> = {
  "bad-qr": "That isn't a Shellbell pairing code.",
  "bad-code": "That code expired — run `shellbell pair` again.",
  declined: "The computer declined.",
  "no-window": "No pairing window is open on that computer.",
  "no-agent": "The computer isn't online.",
  "too-many": "That computer already has the maximum number of paired phones.",
  timeout: "Pairing timed out. Run `shellbell pair` again and rescan.",
  relay: "Couldn't reach the relay.",
};

const APP_VERSION = Constants.expoConfig?.version ?? "0.1.0";

export default function PairScreen() {
  const [perm, requestPerm, getPerm] = useCameraPermissions();
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [needsRescan, setNeedsRescan] = useState(false);
  const guard = useRef(new ScanGuard());
  const router = useRouter();
  const add = useComputersStore((s) => s.add);
  useEffect(() => {
    const subscription = AppState.addEventListener("change", (state) => {
      if (state === "active")
        void getPerm().catch(() => setError("Could not check camera permission. Try again."));
    });
    return () => subscription.remove();
  }, [getPerm]);

  if (!perm?.granted) {
    return (
      <View
        style={{
          flex: 1,
          alignItems: "center",
          justifyContent: "center",
          gap: 12,
          padding: 24,
          backgroundColor: tokens.bg,
        }}
      >
        <Text style={{ color: tokens.text, textAlign: "center" }}>
          Shellbell needs the camera to scan the pairing code your computer shows.
        </Text>
        <Pressable
          accessibilityRole="button"
          disabled={perm === null}
          accessibilityState={{ disabled: perm === null }}
          onPress={() => {
            setError(null);
            const request = perm?.canAskAgain === false ? Linking.openSettings() : requestPerm();
            void request.catch(() => setError("Could not open camera permissions. Try again."));
          }}
          style={{
            backgroundColor: tokens.accents.emerald,
            padding: 12,
            borderRadius: tokens.radius.md,
          }}
        >
          <Text style={{ color: tokens.bg, fontWeight: "600" }}>
            {perm === null
              ? "Checking permission…"
              : perm.canAskAgain === false
                ? "Open Settings"
                : "Allow camera"}
          </Text>
        </Pressable>
        {error ? (
          <Text
            accessibilityRole="alert"
            style={{ color: tokens.accents.rose, textAlign: "center" }}
          >
            {error}
          </Text>
        ) : null}
      </View>
    );
  }

  const confirm = (name: string, fpPrefix: string) =>
    new Promise<boolean>((resolve) => {
      Alert.alert(`Pair with "${name}"?`, `Fingerprint ${fpPrefix}`, [
        { text: "Cancel", style: "cancel", onPress: () => resolve(false) },
        { text: "Pair", onPress: () => resolve(true) },
      ]);
    });

  const onScan = async (data: string) => {
    if (!guard.current.canHandle(data)) return;
    guard.current.begin(data);
    setError(null);
    try {
      const { qr, displayName, fpPrefix } = parsePairingQr(data, { allowInsecure: __DEV__ });
      if (useComputersStore.getState().computers.some((c) => c.fp === qr.c))
        throw new PairingConflictError();
      if (!(await confirm(displayName, fpPrefix))) {
        guard.current.end("cancelled");
        setNeedsRescan(true);
        return;
      }
      setBusy("Pairing… confirm on your computer");
      const { identity, fp } = await loadOrCreateIdentity();
      const r = await runPairing({
        qr,
        identity,
        phoneFp: fp,
        phoneName: Device.deviceName ?? "My phone",
        platform: Platform.OS === "ios" ? "ios" : "android",
        appVersion: APP_VERSION,
      });
      const isFirstComputer = useComputersStore.getState().computers.length === 0;
      await commitNewPairing(r.computerFp, {
        hasRecord: (fp) => useComputersStore.getState().computers.some((c) => c.fp === fp),
        writeSecret: () => savePairSecret(r.computerFp, r.secret),
        addRecord: () =>
          add({
            fp: r.computerFp,
            name: r.computerName,
            accent: r.accent,
            relayUrl: r.relayUrl,
            pairedAt: new Date().toISOString(),
            pairingId: toBase64Url(randomBytes(16)),
            lastSeenAt: null,
            pushEnabled: true,
          }),
      });
      guard.current.end("success");
      await Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      if (isFirstComputer) {
        // Spec 10.8: one line of context before the system dialog, which is otherwise unexplained.
        await new Promise<void>((resolve) => {
          Alert.alert(
            "Let Shellbell ring you?",
            "Shellbell rings you when a command finishes or a program is waiting.",
            [{ text: "Continue", onPress: () => resolve() }],
            // Android alerts are cancelable by default (hardware Back / outside tap dismisses
            // without firing a button's onPress). Without onDismiss the await above would never
            // settle, wedging the first-run flow before the permission prompt and navigation.
            { cancelable: false, onDismiss: () => resolve() },
          );
        });
        if (await requestPermissionOnce()) {
          // The socket already authenticated without a token (permission came later), so register
          // now rather than waiting for the next foreground (review row C7/P2).
          void registerPushTokenWhenConnected(r.computerFp);
        }
      }
      router.replace(`/c/${r.computerFp}`);
    } catch (e) {
      setError(
        e instanceof PairingConflictError
          ? e.message
          : e instanceof PairingError
            ? COPY[e.code]
            : COPY.relay,
      );
      guard.current.end("error");
      setNeedsRescan(true);
    } finally {
      setBusy(null);
    }
  };

  const onRescanTap = () => {
    guard.current.rearm();
    setNeedsRescan(false);
    setError(null);
  };

  return (
    <View style={{ flex: 1, backgroundColor: tokens.bg }}>
      <CameraView
        style={{ flex: 1 }}
        barcodeScannerSettings={{ barcodeTypes: ["qr"] }}
        onBarcodeScanned={(r) => void onScan(r.data)}
      />
      <View style={{ padding: 16, gap: 8 }}>
        <Text style={{ color: tokens.textMuted, textAlign: "center" }}>
          {busy ?? "Run `shellbell pair` on your computer and scan the code."}
        </Text>
        {error ? (
          <Text style={{ color: tokens.accents.rose, textAlign: "center" }}>{error}</Text>
        ) : null}
        {needsRescan ? (
          <Pressable
            accessibilityRole="button"
            onPress={onRescanTap}
            style={{
              backgroundColor: tokens.accents.emerald,
              padding: 12,
              borderRadius: tokens.radius.md,
              alignSelf: "center",
            }}
          >
            <Text style={{ color: tokens.bg, fontWeight: "600" }}>Scan again</Text>
          </Pressable>
        ) : null}
      </View>
    </View>
  );
}
