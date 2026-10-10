import { type ReactNode, useCallback, useEffect, useRef, useState } from "react";
import {
  Animated,
  AppState,
  type AppStateStatus,
  Keyboard,
  Modal,
  Pressable,
  StyleSheet,
  Text,
  View,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { lockAfterAway, useAppLock } from "../security/app-lock";
import {
  authenticate,
  isAuthenticating,
  type UnlockMethod,
  unlockMethod,
} from "../security/unlock-method";
import { useComputersStore } from "../store/computers";
import { tokens } from "../theme/tokens";
import { AppIcon } from "../ui/AppIcon";
import { SplashMark } from "../ui/SplashMark";

const NO_METHOD: UnlockMethod = { available: false, name: "", icon: "lock", fallback: null };

/** Lock only once there is a terminal to protect; a fresh install opens straight to pairing. */
const hasComputers = () => useComputersStore.getState().computers.some((c) => !c.removing);

/**
 * Keeps terminals behind the phone's own Face ID, fingerprint or passcode. The app stays mounted
 * underneath so connections and the visible session stay current; the native modal sits above
 * every screen, including modal routes, and the control gate refuses input while it is up.
 */
export function AppLockGate({ children }: { children: ReactNode }) {
  const locked = useAppLock((s) => s.locked);
  const [method, setMethod] = useState<UnlockMethod | null>(null);
  const [covered, setCovered] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const backgroundAt = useRef<number | null>(null);
  const prompting = useRef(false);

  const promptUnlock = useCallback(async (known?: UnlockMethod) => {
    if (prompting.current || AppState.currentState !== "active") return;
    prompting.current = true;
    setNotice(null);
    try {
      const result = await authenticate("Unlock Shellbell");
      if (result === "unlocked") return useAppLock.getState().unlock();
      if (result === "lockout") setNotice("Too many attempts. Unlock your phone, then try again.");
      else if (result === "failed") setNotice("Could not verify. Try again.");
      else if (result === "unavailable") {
        // The passcode was removed while the app was away; there is nothing left to ask for.
        const current = known?.available ? await unlockMethod().catch(() => known) : known;
        if (!current?.available) {
          setMethod(NO_METHOD);
          useAppLock.getState().unlock();
        }
      }
    } finally {
      prompting.current = false;
    }
  }, []);

  useEffect(() => {
    const { enabled } = useAppLock.getState().hydrate();
    if (!useComputersStore.getState().hydrated) useComputersStore.getState().hydrate();
    if (!enabled || !hasComputers()) {
      useAppLock.getState().unlock();
      return;
    }
    let cancelled = false;
    void unlockMethod()
      .catch(() => NO_METHOD)
      .then((found) => {
        if (cancelled) return;
        setMethod(found);
        if (!found.available) useAppLock.getState().unlock();
        else void promptUnlock(found);
      });
    return () => {
      cancelled = true;
    };
  }, [promptUnlock]);

  useEffect(() => {
    const onChange = (next: AppStateStatus) => {
      const lock = useAppLock.getState();
      if (!lock.hydrated || !lock.enabled || isAuthenticating()) return;
      if (next !== "active") {
        // Covers the app-switcher snapshot, which iOS takes as the app becomes inactive.
        setCovered(true);
        if (next === "background" && backgroundAt.current === null)
          backgroundAt.current = Date.now();
        return;
      }
      setCovered(false);
      const since = backgroundAt.current;
      backgroundAt.current = null;
      // Only a real return from the background asks; cancelling the prompt also ends in "active",
      // and asking again then would trap the user in the prompt.
      if (since === null) return;
      if (lock.locked) {
        if (method?.available) void promptUnlock(method);
        return;
      }
      if (!hasComputers() || !lockAfterAway(Date.now() - since, lock.delayMs)) return;
      Keyboard.dismiss();
      lock.lock();
      // Re-read the device each time: a passcode may have been added or removed while away.
      void unlockMethod()
        .catch(() => NO_METHOD)
        .then((found) => {
          setMethod(found);
          if (found.available) void promptUnlock(found);
          else useAppLock.getState().unlock();
        });
    };
    const subscription = AppState.addEventListener("change", onChange);
    return () => subscription.remove();
  }, [method, promptUnlock]);

  const showLock = locked && method?.available === true;
  return (
    <>
      {children}
      <Modal
        visible={locked || covered}
        animationType={showLock ? "fade" : "none"}
        transparent={false}
        statusBarTranslucent
        navigationBarTranslucent
        onRequestClose={() => undefined}
      >
        {showLock ? (
          <LockScreen method={method} notice={notice} onUnlock={() => void promptUnlock(method)} />
        ) : (
          <View style={styles.cover}>
            <SplashMark />
          </View>
        )}
      </Modal>
    </>
  );
}

function LockScreen({
  method,
  notice,
  onUnlock,
}: {
  method: UnlockMethod;
  notice: string | null;
  onUnlock: () => void;
}) {
  const reveal = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    Animated.timing(reveal, { toValue: 1, duration: 260, useNativeDriver: true }).start();
  }, [reveal]);
  const rise = reveal.interpolate({ inputRange: [0, 1], outputRange: [8, 0] });
  return (
    <SafeAreaView style={styles.screen} accessibilityViewIsModal>
      <View style={styles.center}>
        <View>
          <SplashMark size={128} />
          <View style={styles.badge}>
            <AppIcon name="lock" size={15} color={tokens.text} />
          </View>
        </View>
        <Animated.View
          style={[styles.copy, { opacity: reveal, transform: [{ translateY: rise }] }]}
        >
          <Text accessibilityRole="header" style={styles.title}>
            Shellbell is locked
          </Text>
          <Text style={styles.body}>Unlock to see and control your terminals.</Text>
        </Animated.View>
      </View>
      <Animated.View style={[styles.actions, { opacity: reveal }]}>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={`Unlock with ${method.name}`}
          onPress={onUnlock}
          style={({ pressed }) => [styles.button, pressed && styles.pressed]}
        >
          <AppIcon name={method.icon} size={20} color={tokens.bg} />
          <Text style={styles.buttonText}>Unlock with {method.name}</Text>
        </Pressable>
        <Text accessibilityLiveRegion="polite" style={styles.notice}>
          {notice ?? (method.fallback ? `Your ${method.fallback} also works.` : " ")}
        </Text>
      </Animated.View>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  cover: { flex: 1, backgroundColor: tokens.bg, alignItems: "center", justifyContent: "center" },
  screen: { flex: 1, backgroundColor: tokens.bg, paddingHorizontal: tokens.space[5] },
  center: { flex: 1, alignItems: "center", justifyContent: "center", gap: tokens.space[4] },
  badge: {
    position: "absolute",
    right: 14,
    bottom: 14,
    width: 30,
    height: 30,
    borderRadius: 15,
    backgroundColor: tokens.surface2,
    borderWidth: 1,
    borderColor: tokens.border,
    alignItems: "center",
    justifyContent: "center",
  },
  copy: { alignItems: "center", gap: tokens.space[2] },
  title: { color: tokens.text, fontSize: 22, fontWeight: "600", textAlign: "center" },
  body: { color: tokens.textMuted, fontSize: 15, lineHeight: 21, textAlign: "center" },
  actions: {
    width: "100%",
    maxWidth: 400,
    alignSelf: "center",
    gap: tokens.space[3],
    paddingBottom: tokens.space[5],
  },
  button: {
    minHeight: 52,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: tokens.space[2],
    backgroundColor: tokens.accents.emerald,
    borderRadius: tokens.radius.md,
    paddingHorizontal: tokens.space[4],
  },
  pressed: { opacity: 0.85 },
  buttonText: { color: tokens.bg, fontSize: 16, fontWeight: "600" },
  notice: { color: tokens.textMuted, fontSize: 13, lineHeight: 18, textAlign: "center" },
});
