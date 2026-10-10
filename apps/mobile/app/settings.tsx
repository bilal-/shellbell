import { runVectorChecks, type Vectors } from "@shellbell/protocol";
import * as Application from "expo-application";
import Constants from "expo-constants";
import * as Device from "expo-device";
import { Link } from "expo-router";
import { type ReactNode, useEffect, useState } from "react";
import {
  Alert,
  Linking,
  Pressable,
  ScrollView,
  StyleSheet,
  Switch,
  Text,
  View,
} from "react-native";
import { loadOrCreateIdentity } from "../src/identity/keys";
import { nativeNotifications, nativeNotificationsAvailable } from "../src/notifications/native";
import { saveNotificationPrivacy } from "../src/notifications/privacy";
import { MAX_FONT_SIZE, MIN_FONT_SIZE, useUiStore } from "../src/store/computers";
import { PRIVACY_URL, TERMS_URL } from "../src/store/consent";
import { tokens } from "../src/theme/tokens";
import { AppIcon } from "../src/ui/AppIcon";
import { ShellbellMark } from "../src/ui/ShellbellMark";
import vectors from "../src/util/vectors.json";

const REPO_URL = "https://github.com/bilal-/shellbell";

function SettingsSection({ title, children }: { title: string; children: ReactNode }) {
  return (
    <View style={styles.section}>
      <Text accessibilityRole="header" style={styles.heading}>
        {title}
      </Text>
      <View style={styles.group}>{children}</View>
    </View>
  );
}

export default function SettingsScreen() {
  const [hideDetails, setHideDetails] = useState<boolean | null>(null);
  const [savingPrivacy, setSavingPrivacy] = useState(false);
  useEffect(() => {
    let mounted = true;
    if (nativeNotificationsAvailable)
      void nativeNotifications
        .getHideNotificationDetails()
        .then((hide) => {
          if (mounted) setHideDetails(hide);
        })
        .catch(() => undefined);
    return () => {
      mounted = false;
    };
  }, []);
  const changePrivacy = async (hide: boolean) => {
    if (savingPrivacy) return;
    setSavingPrivacy(true);
    try {
      const result = await saveNotificationPrivacy(nativeNotifications, hide);
      setHideDetails(result.hide);
      if (!result.saved)
        Alert.alert(
          "Could not confirm notification privacy",
          result.hide === null
            ? "The current setting is unknown. Unlock the phone and reopen Settings before relying on hidden details."
            : "The current native setting has been reloaded. Please check the switch before continuing.",
        );
    } finally {
      setSavingPrivacy(false);
    }
  };
  const [results, setResults] = useState<{ name: string; ok: boolean }[] | null>(null);
  const [fp, setFp] = useState<string | null>(null);
  const fontSize = useUiStore((s) => s.fontSize);
  const setFontSize = useUiStore((s) => s.setFontSize);
  const fitWidth = useUiStore((s) => s.fitWidth);
  const setFitWidth = useUiStore((s) => s.setFitWidth);
  const version =
    Application.nativeApplicationVersion ?? Constants.expoConfig?.version ?? "Unknown";
  const build = Application.nativeBuildVersion;
  const decreaseDisabled = fitWidth || fontSize <= MIN_FONT_SIZE;
  const increaseDisabled = fitWidth || fontSize >= MAX_FONT_SIZE;

  useEffect(() => {
    loadOrCreateIdentity()
      .then((r) => setFp(r.fp))
      .catch(() => setFp(null));
  }, []);

  const runSelfTest = () => {
    setResults(runVectorChecks(vectors as Vectors));
  };

  return (
    <ScrollView
      style={styles.container}
      contentContainerStyle={styles.content}
      contentInsetAdjustmentBehavior="automatic"
    >
      <View style={styles.body}>
        <View style={styles.brand}>
          <ShellbellMark />
          <View style={styles.brandText}>
            <Text style={styles.brandName}>Shellbell</Text>
            <Text selectable style={styles.detail}>
              Version {version}
              {build ? ` · Build ${build}` : ""}
            </Text>
          </View>
        </View>

        <SettingsSection title="Terminal display">
          <View style={styles.row}>
            <Text style={[styles.text, styles.rowLabel]}>Scale terminal to fit</Text>
            <Switch
              accessibilityLabel="Scale terminal to fit"
              value={fitWidth}
              onValueChange={setFitWidth}
            />
          </View>
          <Text style={styles.detail}>
            Automatically scales the font to fit the terminal’s columns. Keeps the laptop’s layout;
            does not wrap text.
          </Text>

          <View style={styles.divider} />
          <View style={styles.row}>
            <Text style={[styles.text, styles.rowLabel]}>Font size</Text>
            <View style={[styles.stepper, fitWidth && styles.disabled]}>
              <Pressable
                accessibilityRole="button"
                accessibilityLabel="Decrease font size"
                accessibilityState={{ disabled: decreaseDisabled }}
                accessibilityHint={
                  fitWidth ? "Turn off Scale terminal to fit to change font size." : undefined
                }
                disabled={decreaseDisabled}
                onPress={() => setFontSize(fontSize - 1)}
                style={[styles.stepperButton, !fitWidth && decreaseDisabled && styles.disabled]}
              >
                <AppIcon name="minus" size={20} />
              </Pressable>
              <Text style={styles.stepperValue}>{fitWidth ? "Auto" : fontSize}</Text>
              <Pressable
                accessibilityRole="button"
                accessibilityLabel="Increase font size"
                accessibilityState={{ disabled: increaseDisabled }}
                accessibilityHint={
                  fitWidth ? "Turn off Scale terminal to fit to change font size." : undefined
                }
                disabled={increaseDisabled}
                onPress={() => setFontSize(fontSize + 1)}
                style={[styles.stepperButton, !fitWidth && increaseDisabled && styles.disabled]}
              >
                <AppIcon name="plus" size={20} />
              </Pressable>
            </View>
          </View>
          <Text style={styles.detail}>
            {fitWidth
              ? "Font size is automatic. Turn off Scale terminal to fit to choose a size."
              : "Choose a font size or pinch the terminal to zoom."}
          </Text>
          <View style={styles.tip}>
            <Text style={styles.tipTitle}>Want wrapped text?</Text>
            <Text style={styles.detail}>
              Tap Read in a session. Reading mode wraps text for your phone without changing the
              laptop’s terminal.
            </Text>
          </View>
        </SettingsSection>

        <SettingsSection title="Notifications">
          <View style={styles.row}>
            <Text style={[styles.text, styles.rowLabel]}>Hide notification details</Text>
            {hideDetails === null ? (
              <Text style={styles.detail}>Unavailable</Text>
            ) : (
              <Switch
                accessibilityLabel="Hide notification details"
                value={hideDetails}
                disabled={savingPrivacy}
                onValueChange={(hide) => void changePrivacy(hide)}
              />
            )}
          </View>
          <Text style={styles.detail}>
            {hideDetails === null
              ? "Notification privacy is unavailable in this build or while storage is locked."
              : "Hide session, repository and branch names in future notifications. Already delivered alerts and system notification history are unchanged."}
          </Text>
        </SettingsSection>

        <SettingsSection title="This phone">
          <Text style={styles.text}>{Device.deviceName ?? "My phone"}</Text>
          <Text selectable style={styles.detail}>
            {fp ? `Pairing fingerprint: ${fp.slice(0, 12)}…` : "Loading pairing identity…"}
          </Text>
        </SettingsSection>

        <SettingsSection title="About">
          <Pressable
            accessibilityRole="link"
            onPress={() => void Linking.openURL(TERMS_URL)}
            style={styles.linkRow}
          >
            <Text style={styles.link}>Terms of Use</Text>
            <Text style={styles.detail}>Access, responsibilities and service limits</Text>
          </Pressable>
          <View style={styles.divider} />
          <Pressable
            accessibilityRole="link"
            onPress={() => void Linking.openURL(PRIVACY_URL)}
            style={styles.linkRow}
          >
            <Text style={styles.link}>Privacy</Text>
            <Text style={styles.detail}>Data, encryption and deletion</Text>
          </Pressable>
          <View style={styles.divider} />
          <Pressable
            accessibilityRole="link"
            onPress={() => void Linking.openURL(REPO_URL)}
            style={styles.linkRow}
          >
            <Text style={styles.link}>Shellbell on GitHub</Text>
            <Text style={styles.detail}>Source code and guides</Text>
          </Pressable>
          <View style={styles.divider} />
          <Link href="/licenses" asChild>
            <Pressable accessibilityRole="link" style={styles.linkRow}>
              <Text style={styles.link}>Open-source credits</Text>
              <Text style={styles.detail}>MIT License · xterm.js and other dependencies</Text>
            </Pressable>
          </Link>
          <View style={styles.divider} />
          <Pressable
            accessibilityRole="link"
            onPress={() => void Linking.openURL("https://bilal.sh")}
            style={styles.linkRow}
          >
            <Text style={styles.link}>Made by Bilal</Text>
            <Text style={styles.detail}>bilal.sh</Text>
          </Pressable>
        </SettingsSection>

        {__DEV__ && (
          <SettingsSection title="Developer">
            <Pressable accessibilityRole="button" onPress={runSelfTest} style={styles.button}>
              <Text style={styles.buttonText}>Run crypto self-test</Text>
            </Pressable>
            {results && (
              <View style={styles.results}>
                {results.map((r) => (
                  <Text key={r.name} style={styles.text}>
                    {r.ok ? "Passed" : "Failed"}: {r.name}
                  </Text>
                ))}
              </View>
            )}
            <Link href="/dev/render-spike" style={styles.link}>
              Render spike
            </Link>
          </SettingsSection>
        )}
        <Text style={styles.footer}>
          Type directly in the terminal, or use Compose to review a command before sending.
        </Text>
      </View>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: tokens.bg },
  content: { padding: tokens.space[4], paddingBottom: tokens.space[6], alignItems: "center" },
  body: { width: "100%", maxWidth: 620, gap: tokens.space[5] },
  brand: {
    flexDirection: "row",
    alignItems: "center",
    gap: tokens.space[3],
    paddingVertical: tokens.space[2],
  },
  brandText: { flex: 1, gap: 3 },
  brandName: { color: tokens.text, fontSize: 23, fontWeight: "600" },
  section: { gap: tokens.space[2] },
  heading: { color: tokens.text, fontSize: 16, fontWeight: "600", paddingHorizontal: 2 },
  group: {
    gap: tokens.space[2],
    backgroundColor: tokens.surface,
    borderWidth: 1,
    borderColor: tokens.border,
    borderRadius: tokens.radius.md,
    padding: tokens.space[4],
  },
  row: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: tokens.space[3],
  },
  rowLabel: { flex: 1 },
  stepper: { flexDirection: "row", alignItems: "center", gap: tokens.space[2] },
  stepperButton: {
    width: 44,
    height: 44,
    borderRadius: tokens.radius.sm,
    borderWidth: 1,
    borderColor: tokens.border,
    backgroundColor: tokens.surface2,
    alignItems: "center",
    justifyContent: "center",
  },
  stepperValue: {
    color: tokens.text,
    fontSize: 15,
    minWidth: 36,
    textAlign: "center",
    fontVariant: ["tabular-nums"],
  },
  disabled: { opacity: 0.4 },
  text: { color: tokens.text, fontSize: 15, lineHeight: 21 },
  detail: { color: tokens.textMuted, fontSize: 13, lineHeight: 19 },
  divider: { height: 1, backgroundColor: tokens.border, marginVertical: tokens.space[2] },
  tip: { gap: 4, marginTop: tokens.space[2] },
  tipTitle: { color: tokens.text, fontSize: 13, fontWeight: "500" },
  linkRow: { minHeight: 44, justifyContent: "center", gap: 3 },
  link: { color: tokens.accents.amber, fontSize: 15 },
  button: {
    padding: tokens.space[3],
    backgroundColor: tokens.accents.blue,
    borderRadius: tokens.radius.sm,
    alignItems: "center",
  },
  buttonText: { color: tokens.bg },
  results: { alignItems: "flex-start", gap: 2 },
  footer: { color: tokens.textMuted, fontSize: 12, lineHeight: 18, paddingHorizontal: 2 },
});
