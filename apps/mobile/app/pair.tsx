import { randomBytes, toBase64Url } from "@shellbell/protocol";
import { type BarcodeScanningResult, CameraView, useCameraPermissions } from "expo-camera";
import Constants from "expo-constants";
import * as Device from "expo-device";
import * as Haptics from "expo-haptics";
import { useRouter } from "expo-router";
import { useEffect, useRef, useState } from "react";
import {
  ActivityIndicator,
  Alert,
  AppState,
  Linking,
  Platform,
  Pressable,
  ScrollView,
  Text,
  View,
} from "react-native";
import { RelayConsentError, requestRelayConsent } from "../src/components/relay-consent";
import { loadOrCreateIdentity, savePairSecret } from "../src/identity/keys";
import {
  type PairingCode,
  PairingError,
  type PairingProgress,
  parsePairingQr,
  runPairing,
} from "../src/net/pairing";
import { ScanGuard } from "../src/net/scan-guard";
import { registerPushTokenWhenConnected, requestPermissionOnce } from "../src/notifications";
import { commitNewPairing, PairingConflictError } from "../src/notifications/cleanup";
import { useComputersStore } from "../src/store/computers";
import { tokens } from "../src/theme/tokens";
import { isCustomRelay, relayTrustMessage } from "../src/util/relay-trust";
import { type ScanRect, scanHighlight } from "../src/util/scan-highlight";

const COPY: Record<PairingCode, string> = {
  "bad-qr": "That isn't a Shellbell pairing code.",
  "bad-code":
    "That code expired. Choose Pair Device in Shellbell or run `shellbell pair` on your computer for a new code.",
  declined: "The computer declined.",
  "no-window": "No pairing window is open on that computer.",
  "no-agent": "The computer isn't online.",
  "too-many":
    "The computer cannot accept another pairing right now. Decline any pending request or remove an unused paired device there, then try again.",
  timeout:
    "Pairing timed out. Choose Pair Device in Shellbell or run `shellbell pair` on your computer, then scan the new code.",
  relay: "Couldn't reach the relay.",
  cancelled:
    "Stopped waiting on this device. Decline any pending request on your computer. If you already approved it, remove this device on the computer before trying again.",
};

const APP_VERSION = Constants.expoConfig?.version ?? "0.1.0";

export default function PairScreen() {
  const [perm, requestPerm, getPerm] = useCameraPermissions();
  const [progress, setProgress] = useState<PairingProgress | "saving" | "paired" | null>(null);
  const [capture, setCapture] = useState<ReturnType<typeof parsePairingQr> | null>(null);
  const [highlight, setHighlight] = useState<ScanRect | null>(null);
  const [previewSize, setPreviewSize] = useState({ width: 0, height: 0 });
  const [cameraKey, setCameraKey] = useState(0);
  const camera = useRef<CameraView | null>(null);
  const attempt = useRef<AbortController | null>(null);
  const mounted = useRef(true);
  const [error, setError] = useState<string | null>(null);
  const [needsRescan, setNeedsRescan] = useState(false);
  const [confirmingRelay, setConfirmingRelay] = useState(false);
  const guard = useRef(new ScanGuard());
  const router = useRouter();
  const add = useComputersStore((s) => s.add);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      attempt.current?.abort();
    };
  }, []);
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

  const onScan = (result: BarcodeScanningResult) => {
    if (!guard.current.canHandle(result.data)) return;
    guard.current.begin(result.data);
    setError(null);
    void camera.current?.pausePreview().catch(() => {});
    try {
      const parsed = parsePairingQr(result.data, { allowInsecure: __DEV__ });
      if (useComputersStore.getState().computers.some((c) => c.fp === parsed.qr.c))
        throw new PairingConflictError();
      setHighlight(scanHighlight(result.bounds, previewSize));
      setCapture(parsed);
    } catch (cause) {
      guard.current.end("error");
      setNeedsRescan(true);
      setError(cause instanceof PairingConflictError ? cause.message : COPY["bad-qr"]);
    }
  };

  const pair = async () => {
    if (!capture || attempt.current) return;
    const controller = new AbortController();
    attempt.current = controller;
    setConfirmingRelay(true);
    try {
      if (
        !(await requestRelayConsent(
          capture.qr.r,
          () => mounted.current && !controller.signal.aborted,
        ))
      )
        return;
      if (controller.signal.aborted) return;
      setConfirmingRelay(false);
      setProgress("connecting");
      const { identity, fp } = await loadOrCreateIdentity();
      if (controller.signal.aborted) throw new PairingError("cancelled");
      const r = await runPairing({
        qr: capture.qr,
        identity,
        phoneFp: fp,
        phoneName: Device.deviceName ?? "My phone",
        platform: Platform.OS === "ios" ? "ios" : "android",
        appVersion: APP_VERSION,
        signal: controller.signal,
        onProgress: (next) => {
          if (mounted.current) setProgress(next);
        },
      });
      if (controller.signal.aborted) throw new PairingError("cancelled");
      setProgress("saving");
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
      if (!mounted.current) return;
      setProgress("paired");
      void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success).catch(() => {});
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
        if (!mounted.current) return;
        if (await requestPermissionOnce().catch(() => false)) {
          // The socket already authenticated without a token (permission came later), so register
          // now rather than waiting for the next foreground (review row C7/P2).
          void registerPushTokenWhenConnected(r.computerFp);
        }
      }
      if (mounted.current) router.replace(`/c/${r.computerFp}`);
    } catch (e) {
      if (!mounted.current) return;
      if (e instanceof RelayConsentError) {
        setError(e.message);
        return;
      }
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
      attempt.current = null;
      if (mounted.current) {
        setProgress(null);
        setConfirmingRelay(false);
      }
    }
  };

  const onRescanTap = () => {
    guard.current.end("cancelled");
    guard.current.rearm();
    setCapture(null);
    setHighlight(null);
    setCameraKey((key) => key + 1);
    setNeedsRescan(false);
    setError(null);
  };

  const progressTitle =
    progress === "connecting"
      ? "Connecting to your computer…"
      : progress === "awaiting-approval"
        ? "Waiting for computer approval"
        : progress === "saving"
          ? "Saving this computer…"
          : "Computer paired";
  const captured = capture !== null;
  const frameColor = captured ? tokens.accents.emerald : tokens.text;

  return (
    <View style={{ flex: 1, backgroundColor: tokens.bg }}>
      <View
        onLayout={(event) => {
          const { width, height } = event.nativeEvent.layout;
          setPreviewSize({ width, height });
          setHighlight(null);
        }}
        style={{
          flex: 2,
          minHeight: 160,
          alignItems: "center",
          justifyContent: "center",
          overflow: "hidden",
        }}
      >
        {progress ? (
          <View
            accessibilityLiveRegion="polite"
            style={{ padding: 24, gap: 16, alignItems: "center" }}
          >
            {progress !== "paired" ? (
              <ActivityIndicator size="large" color={tokens.accents.emerald} />
            ) : null}
            <Text
              style={{ color: tokens.text, fontSize: 22, fontWeight: "600", textAlign: "center" }}
            >
              {progressTitle}
            </Text>
            {progress === "awaiting-approval" ? (
              <Text style={{ color: tokens.textMuted, textAlign: "center" }}>
                Approve this device in Shellbell on {capture?.displayName}. Keep this screen open.
                To stop pairing, decline the request on your computer. Leaving this screen only
                stops waiting on this device.
              </Text>
            ) : null}
          </View>
        ) : (
          <>
            <CameraView
              key={cameraKey}
              ref={camera}
              style={{ position: "absolute", top: 0, right: 0, bottom: 0, left: 0 }}
              barcodeScannerSettings={{ barcodeTypes: ["qr"] }}
              onBarcodeScanned={captured || needsRescan ? undefined : onScan}
            />
            <View
              pointerEvents="none"
              style={
                highlight
                  ? {
                      position: "absolute",
                      ...highlight,
                      borderWidth: 3,
                      borderRadius: 12,
                      borderColor: frameColor,
                    }
                  : {
                      width: "65%",
                      maxWidth: 280,
                      height: "70%",
                      maxHeight: 280,
                      borderWidth: 3,
                      borderRadius: 16,
                      borderColor: frameColor,
                    }
              }
            />
            <Text
              accessibilityLiveRegion="polite"
              style={{
                position: "absolute",
                bottom: 12,
                color: tokens.text,
                backgroundColor: tokens.bg,
                paddingHorizontal: 12,
                paddingVertical: 8,
                borderRadius: 8,
              }}
            >
              {captured ? "Code captured" : "Place the QR code inside the frame"}
            </Text>
          </>
        )}
      </View>
      <ScrollView style={{ flex: 1 }} contentContainerStyle={{ padding: 20, gap: 12 }}>
        {capture && !progress && !needsRescan ? (
          <>
            <Text style={{ color: tokens.text, fontSize: 20, fontWeight: "600" }}>
              Pair with {capture.displayName}?
            </Text>
            <Text style={{ color: tokens.textMuted }}>Fingerprint {capture.fpPrefix}</Text>
            <Text style={{ color: tokens.textMuted }}>
              Pairing lets this device read and control terminals shared by this computer. Only pair
              computers you trust.
            </Text>
            {isCustomRelay(capture.qr.r) ? (
              <Text style={{ color: tokens.textMuted }}>{relayTrustMessage(capture.qr.r)}</Text>
            ) : null}
            <Pressable
              accessibilityRole="button"
              disabled={confirmingRelay}
              accessibilityState={{ disabled: confirmingRelay }}
              onPress={() => void pair()}
              style={primaryButton}
            >
              <Text style={{ color: tokens.bg, fontWeight: "600" }}>Pair computer</Text>
            </Pressable>
            <Pressable
              accessibilityRole="button"
              disabled={confirmingRelay}
              accessibilityState={{ disabled: confirmingRelay }}
              onPress={onRescanTap}
              style={secondaryButton}
            >
              <Text style={{ color: tokens.text }}>Scan another code</Text>
            </Pressable>
          </>
        ) : null}
        {!capture && !error && !progress ? (
          <Text style={{ color: tokens.textMuted, textAlign: "center" }}>
            On your computer, open Shellbell and choose Pair Device, or run `shellbell pair` in
            Terminal.
          </Text>
        ) : null}
        {progress === "connecting" || progress === "awaiting-approval" ? (
          <Pressable
            accessibilityRole="button"
            onPress={() => attempt.current?.abort()}
            style={secondaryButton}
          >
            <Text style={{ color: tokens.text }}>Stop waiting</Text>
          </Pressable>
        ) : null}
        {error ? (
          <Text accessibilityRole="alert" style={{ color: tokens.accents.rose }}>
            {error}
          </Text>
        ) : null}
        {needsRescan ? (
          <Pressable accessibilityRole="button" onPress={onRescanTap} style={primaryButton}>
            <Text style={{ color: tokens.bg, fontWeight: "600" }}>Scan again</Text>
          </Pressable>
        ) : null}
      </ScrollView>
    </View>
  );
}

const primaryButton = {
  backgroundColor: tokens.accents.emerald,
  padding: 14,
  borderRadius: tokens.radius.md,
  alignItems: "center",
} as const;
const secondaryButton = { ...primaryButton, backgroundColor: tokens.surface2 } as const;
