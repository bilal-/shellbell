import { formatFingerprint, randomBytes, toBase64Url } from "@shellbell/protocol";
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
import { loadOrCreateIdentity, savePairSecret } from "../src/identity/keys";
import {
  PairingError,
  type PairingProgress,
  type PairingResult,
  parsePairingQr,
  runPairing,
} from "../src/net/pairing";
import {
  ALREADY_PAIRED,
  CAMERA_FAILED,
  type PairingFailure,
  pairingFailure,
  SAVE_FAILED,
} from "../src/net/pairing-failure";
import { ScanGuard } from "../src/net/scan-guard";
import { registerPushTokenWhenConnected, requestPermissionOnce } from "../src/notifications";
import { commitNewPairing, PairingConflictError } from "../src/notifications/cleanup";
import { useComputersStore } from "../src/store/computers";
import { acceptRelay } from "../src/store/consent";
import { FONT, tokens } from "../src/theme/tokens";
import { isCustomRelay, relayTrustMessage } from "../src/util/relay-trust";

const APP_VERSION = Constants.expoConfig?.version ?? "0.1.0";

type Capture = ReturnType<typeof parsePairingQr>;
/**
 * One screen state at a time. The camera runs only while scanning; every later state turns
 * it off, and only a button press brings it back.
 */
type Step =
  | { readonly kind: "scanning"; readonly notice?: string }
  | { readonly kind: "read"; readonly capture: Capture; readonly error?: string }
  | {
      readonly kind: "working";
      readonly capture: Capture;
      readonly progress: PairingProgress | "saving";
    }
  | {
      readonly kind: "failed";
      readonly failure: PairingFailure;
      readonly capture?: Capture;
      readonly result?: PairingResult;
      readonly fp?: string;
    }
  | { readonly kind: "paired" };

export default function PairScreen() {
  const [perm, requestPerm, getPerm] = useCameraPermissions();
  const [step, setStep] = useState<Step>({ kind: "scanning" });
  const [phoneFp, setPhoneFp] = useState<string | null>(null);
  const [permissionError, setPermissionError] = useState<string | null>(null);
  const attempt = useRef<AbortController | null>(null);
  /**
   * Times each code was tried again, by its pairing secret; past the allowance only a new code
   * is offered. Scanning the same code again doesn't reset it.
   */
  const tries = useRef(new Map<string, number>());
  const mounted = useRef(true);
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
        void getPerm().catch(() =>
          setPermissionError("Could not check camera permission. Try again."),
        );
    });
    return () => subscription.remove();
  }, [getPerm]);

  /** Saving an approved pairing; a second press must not save it twice. */
  const saving = useRef(false);

  const scanAgain = () => {
    // Any attempt still running belongs to the code being left behind.
    attempt.current?.abort();
    attempt.current = null;
    guard.current.end("cancelled");
    guard.current.rearm();
    setStep({ kind: "scanning" });
  };

  const onScan = (result: BarcodeScanningResult) => {
    if (!guard.current.canHandle(result.data)) return;
    guard.current.begin(result.data);
    let capture: Capture;
    try {
      capture = parsePairingQr(result.data, { allowInsecure: __DEV__ });
    } catch (cause) {
      guard.current.end("error");
      if (cause instanceof PairingError && cause.code === "expired") {
        setStep({ kind: "failed", failure: pairingFailure(cause, 0) });
        return;
      }
      // Shown over the live camera, which keeps scanning; this code is ignored until another.
      guard.current.dismiss();
      setStep({ kind: "scanning", notice: "That isn't a Shellbell pairing code." });
      return;
    }
    void Haptics.selectionAsync().catch(() => {});
    if (useComputersStore.getState().computers.some((c) => c.fp === capture.qr.c)) {
      guard.current.end("error");
      setStep({ kind: "failed", failure: ALREADY_PAIRED, fp: capture.qr.c });
      return;
    }
    setStep({ kind: "read", capture });
  };

  /** Saves an approved pairing; on failure, offers to save again without a new request. */
  const save = async (capture: Capture | undefined, r: PairingResult) => {
    if (saving.current) return;
    saving.current = true;
    try {
      await saveOnce(capture, r);
    } finally {
      saving.current = false;
    }
  };
  const saveOnce = async (capture: Capture | undefined, r: PairingResult) => {
    if (capture) setStep({ kind: "working", capture, progress: "saving" });
    const isFirstComputer = useComputersStore.getState().computers.length === 0;
    try {
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
    } catch (cause) {
      if (!mounted.current) return;
      setStep(
        cause instanceof PairingConflictError
          ? { kind: "failed", failure: ALREADY_PAIRED, fp: r.computerFp }
          : { kind: "failed", failure: SAVE_FAILED, capture, result: r },
      );
      return;
    }
    guard.current.end("success");
    if (!mounted.current) return;
    setStep({ kind: "paired" });
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
  };

  const pair = async (capture: Capture, retry = false) => {
    if (attempt.current) return;
    // Counted only once this press owns the attempt, so an ignored double tap costs nothing.
    if (retry) tries.current.set(capture.qr.p, (tries.current.get(capture.qr.p) ?? 0) + 1);
    if (isCustomRelay(capture.qr.r)) {
      // The card already shows the relay notice; pressing Pair computer is the consent.
      try {
        acceptRelay(capture.qr.r);
      } catch {
        setStep({ kind: "read", capture, error: "Could not save your relay choice. Try again." });
        return;
      }
    }
    const controller = new AbortController();
    attempt.current = controller;
    setStep({ kind: "working", capture, progress: "connecting" });
    let r: PairingResult;
    try {
      // Stop takes effect at once, even while the identity is still loading.
      const { identity, fp } = await new Promise<Awaited<ReturnType<typeof loadOrCreateIdentity>>>(
        (resolve, reject) => {
          controller.signal.addEventListener("abort", () => reject(new PairingError("cancelled")), {
            once: true,
          });
          loadOrCreateIdentity().then(resolve, reject);
        },
      );
      if (controller.signal.aborted) throw new PairingError("cancelled");
      setPhoneFp(fp);
      r = await runPairing({
        qr: capture.qr,
        identity,
        phoneFp: fp,
        phoneName: Device.deviceName ?? "My phone",
        platform: Platform.OS === "ios" ? "ios" : "android",
        appVersion: APP_VERSION,
        signal: controller.signal,
        onProgress: (progress) => {
          if (mounted.current && !controller.signal.aborted)
            setStep({ kind: "working", capture, progress });
        },
      });
      if (controller.signal.aborted) throw new PairingError("cancelled", true);
    } catch (cause) {
      // A newer attempt, or Scan a different code, has taken over the screen.
      if (attempt.current !== controller) return;
      attempt.current = null;
      if (!mounted.current) return;
      guard.current.end("error");
      setStep({
        kind: "failed",
        failure: pairingFailure(cause, tries.current.get(capture.qr.p) ?? 0),
        capture,
      });
      return;
    }
    if (attempt.current !== controller) return;
    attempt.current = null;
    await save(capture, r);
  };

  const act = (failed: Extract<Step, { kind: "failed" }>) => {
    switch (failed.failure.action) {
      case "retry":
        if (!failed.capture) return scanAgain();
        return void pair(failed.capture, true);
      case "save":
        if (!failed.result) return scanAgain();
        return void save(failed.capture, failed.result);
      case "open":
        if (failed.fp) return router.replace(`/c/${failed.fp}`);
        return scanAgain();
      case "camera":
      case "rescan":
        return scanAgain();
    }
  };

  if (step.kind === "scanning" && !perm?.granted)
    return (
      <View style={[centered, { backgroundColor: tokens.bg }]}>
        <Text style={{ color: tokens.text, textAlign: "center" }}>
          Shellbell needs the camera to scan the pairing code your computer shows.
        </Text>
        <Pressable
          accessibilityRole="button"
          disabled={perm === null}
          accessibilityState={{ disabled: perm === null }}
          onPress={() => {
            setPermissionError(null);
            const request = perm?.canAskAgain === false ? Linking.openSettings() : requestPerm();
            void request.catch(() =>
              setPermissionError("Could not open camera permissions. Try again."),
            );
          }}
          style={primaryButton}
        >
          <Text style={{ color: tokens.bg, fontWeight: "600" }}>
            {perm === null
              ? "Checking permission…"
              : perm.canAskAgain === false
                ? "Open Settings"
                : "Allow camera"}
          </Text>
        </Pressable>
        {permissionError ? (
          <Text
            accessibilityRole="alert"
            style={{ color: tokens.accents.rose, textAlign: "center" }}
          >
            {permissionError}
          </Text>
        ) : null}
      </View>
    );

  if (step.kind === "scanning")
    return (
      <View style={{ flex: 1, backgroundColor: tokens.bg }}>
        <CameraView
          style={{ position: "absolute", top: 0, right: 0, bottom: 0, left: 0 }}
          barcodeScannerSettings={{ barcodeTypes: ["qr"] }}
          onBarcodeScanned={onScan}
          onMountError={() => setStep({ kind: "failed", failure: CAMERA_FAILED })}
        />
        <View style={[centered, { padding: 0 }]} pointerEvents="none">
          <View
            style={{
              width: "70%",
              maxWidth: 300,
              aspectRatio: 1,
              borderWidth: 3,
              borderRadius: 16,
              borderColor: tokens.text,
            }}
          />
        </View>
        <View
          accessibilityLiveRegion="polite"
          style={{ position: "absolute", bottom: 32, left: 20, right: 20, alignItems: "center" }}
        >
          <Text style={[scanLabel, step.notice ? { color: tokens.accents.rose } : null]}>
            {step.notice ?? "Point at the QR code on your computer"}
          </Text>
        </View>
      </View>
    );

  if (step.kind === "paired")
    return (
      <View accessibilityLiveRegion="polite" style={[centered, { backgroundColor: tokens.bg }]}>
        <Text style={title}>Computer paired</Text>
      </View>
    );

  if (step.kind === "failed") {
    const { failure } = step;
    return (
      <ScrollView
        style={{ flex: 1, backgroundColor: tokens.bg }}
        contentContainerStyle={[centered, { flexGrow: 1 }]}
      >
        <Text accessibilityRole="alert" style={title}>
          {failure.title}
        </Text>
        {failure.body ? <Text style={muted}>{failure.body}</Text> : null}
        <Pressable accessibilityRole="button" onPress={() => act(step)} style={primaryButton}>
          <Text style={{ color: tokens.bg, fontWeight: "600" }}>{failure.label}</Text>
        </Pressable>
        {failure.action === "camera" && perm?.canAskAgain === false ? (
          <Pressable
            accessibilityRole="button"
            onPress={() => void Linking.openSettings().catch(() => {})}
            style={secondaryButton}
          >
            <Text style={{ color: tokens.text }}>Open Settings</Text>
          </Pressable>
        ) : null}
      </ScrollView>
    );
  }

  const { capture } = step;
  return (
    <ScrollView
      style={{ flex: 1, backgroundColor: tokens.bg }}
      contentContainerStyle={{ flexGrow: 1, justifyContent: "center", padding: 20, gap: 12 }}
    >
      <View style={card}>
        <Text style={{ color: tokens.text, fontSize: 20, fontWeight: "600" }}>
          {capture.displayName}
        </Text>
        <Text style={cardText}>Fingerprint {capture.fpPrefix}</Text>
        <Text style={cardText}>
          Pairing lets this phone read and control terminals shared by this computer. Only pair
          computers you trust.
        </Text>
        {isCustomRelay(capture.qr.r) ? (
          <Text style={cardText}>{relayTrustMessage(capture.qr.r)}</Text>
        ) : null}
      </View>
      {step.kind === "read" ? (
        <>
          {step.error ? (
            <Text accessibilityRole="alert" style={{ color: tokens.accents.rose }}>
              {step.error}
            </Text>
          ) : null}
          <Pressable
            accessibilityRole="button"
            onPress={() => void pair(capture)}
            style={primaryButton}
          >
            <Text style={{ color: tokens.bg, fontWeight: "600" }}>Pair computer</Text>
          </Pressable>
          <Pressable accessibilityRole="button" onPress={scanAgain} style={secondaryButton}>
            <Text style={{ color: tokens.text }}>Scan a different code</Text>
          </Pressable>
        </>
      ) : (
        <View accessibilityLiveRegion="polite" style={{ gap: 12, alignItems: "center" }}>
          <ActivityIndicator size="large" color={tokens.accents.emerald} />
          <Text style={title}>
            {step.progress === "connecting"
              ? "Connecting to your computer…"
              : step.progress === "awaiting-approval"
                ? "Waiting for your computer to approve"
                : "Saving this computer…"}
          </Text>
          {step.progress === "awaiting-approval" ? (
            <>
              <Text style={muted}>
                Approve this phone on {capture.displayName}. Keep this screen open.
              </Text>
              {phoneFp ? (
                <View
                  accessible
                  accessibilityLabel={`This phone's fingerprint: ${phoneFp.split("").join(" ")}`}
                  style={[card, { alignSelf: "stretch" }]}
                >
                  <Text style={[muted, { fontSize: 13 }]}>This phone’s fingerprint</Text>
                  <Text
                    selectable
                    style={{
                      color: tokens.text,
                      fontFamily: FONT.regular,
                      fontSize: 17,
                      letterSpacing: 0.5,
                      lineHeight: 26,
                      textAlign: "center",
                    }}
                  >
                    {formatFingerprint(phoneFp)}
                  </Text>
                  <Text style={[muted, { fontSize: 13 }]}>
                    Allow only if your computer shows the same fingerprint.
                  </Text>
                </View>
              ) : null}
            </>
          ) : null}
          {step.progress !== "saving" ? (
            <Pressable
              accessibilityRole="button"
              onPress={() => attempt.current?.abort()}
              style={[secondaryButton, { alignSelf: "stretch" }]}
            >
              <Text style={{ color: tokens.text }}>Stop</Text>
            </Pressable>
          ) : null}
        </View>
      )}
    </ScrollView>
  );
}

const centered = {
  flex: 1,
  alignItems: "center",
  justifyContent: "center",
  gap: 12,
  padding: 24,
} as const;
const title = { color: tokens.text, fontSize: 22, fontWeight: "600", textAlign: "center" } as const;
const muted = { color: tokens.textMuted, textAlign: "center" } as const;
const cardText = { color: tokens.textMuted } as const;
const scanLabel = {
  color: tokens.text,
  backgroundColor: tokens.bg,
  paddingHorizontal: 14,
  paddingVertical: 8,
  borderRadius: 8,
  overflow: "hidden",
  textAlign: "center",
} as const;
const card = {
  gap: tokens.space[2],
  padding: tokens.space[4],
  borderRadius: tokens.radius.md,
  borderWidth: 1,
  borderColor: tokens.border,
  backgroundColor: tokens.surface,
} as const;
const primaryButton = {
  alignSelf: "stretch",
  backgroundColor: tokens.accents.emerald,
  padding: 14,
  borderRadius: tokens.radius.md,
  alignItems: "center",
} as const;
const secondaryButton = { ...primaryButton, backgroundColor: tokens.surface2 } as const;
