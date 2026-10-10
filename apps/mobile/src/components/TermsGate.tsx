import { type ReactNode, useCallback, useEffect, useState } from "react";
import { Linking, Pressable, ScrollView, StyleSheet, Text } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { acceptTerms, hasAcceptedTerms, PRIVACY_URL, TERMS_URL } from "../store/consent";
import { tokens } from "../theme/tokens";

export function TermsGate({ children }: { children: ReactNode }) {
  const [status, setStatus] = useState<"loading" | "review" | "declined" | "accepted">("loading");
  const [error, setError] = useState<string | null>(null);
  const load = useCallback(() => {
    try {
      setStatus(hasAcceptedTerms() ? "accepted" : "review");
      setError(null);
    } catch {
      setStatus("review");
      setError("Could not read your saved choice. Try again.");
    }
  }, []);
  useEffect(load, [load]);

  if (status === "accepted") return children;
  const open = (url: string) => {
    void Linking.openURL(url).catch(() => setError("Could not open the link. Please try again."));
  };
  return (
    <SafeAreaView style={styles.screen}>
      <ScrollView contentContainerStyle={styles.content}>
        <Text accessibilityRole="header" style={styles.title}>
          {status === "declined" ? "You haven’t agreed to the terms" : "Before you connect"}
        </Text>
        <Text style={styles.body}>
          Shellbell gives a paired device access to your computer’s terminals. Commands can read,
          change or delete data. Only pair devices you trust.
        </Text>
        <Text style={styles.body}>
          This is a free, open source project with voluntary hosting and support. Security,
          availability and notification delivery are not guaranteed.
        </Text>
        <Pressable accessibilityRole="link" onPress={() => open(TERMS_URL)} style={styles.link}>
          <Text style={styles.linkText}>Terms of Use</Text>
        </Pressable>
        <Pressable accessibilityRole="link" onPress={() => open(PRIVACY_URL)} style={styles.link}>
          <Text style={styles.linkText}>Privacy</Text>
        </Pressable>
        {error && (
          <Text accessibilityRole="alert" style={styles.error}>
            {error}
          </Text>
        )}
        {status === "loading" ? (
          <Text style={styles.body}>Checking your saved choice…</Text>
        ) : status === "declined" ? (
          <>
            <Text style={styles.body}>
              Shellbell will stay on this screen. You can close the app or review your choice.
            </Text>
            <Pressable accessibilityRole="button" style={styles.button} onPress={load}>
              <Text style={styles.buttonText}>Review terms</Text>
            </Pressable>
          </>
        ) : (
          <>
            <Text style={styles.body}>
              By selecting Agree, you accept the Terms of Use. The Privacy notice explains how
              Shellbell handles data. Your MIT License rights remain unchanged.
            </Text>
            <Pressable
              accessibilityRole="button"
              style={styles.button}
              onPress={() => {
                try {
                  acceptTerms();
                  setStatus("accepted");
                } catch {
                  setError("Could not save your agreement. Please try again.");
                }
              }}
            >
              <Text style={styles.buttonText}>Agree</Text>
            </Pressable>
            <Pressable
              accessibilityRole="button"
              style={styles.link}
              onPress={() => setStatus("declined")}
            >
              <Text style={styles.linkText}>Decline</Text>
            </Pressable>
          </>
        )}
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: tokens.bg },
  content: {
    flexGrow: 1,
    justifyContent: "center",
    padding: 24,
    gap: 16,
    maxWidth: 560,
    width: "100%",
    alignSelf: "center",
  },
  title: { color: tokens.text, fontSize: 26, fontWeight: "600" },
  body: { color: tokens.textMuted, fontSize: 16, lineHeight: 24 },
  link: { paddingVertical: 12 },
  linkText: { color: tokens.text, fontSize: 16, textDecorationLine: "underline" },
  button: {
    backgroundColor: tokens.accents.emerald,
    padding: 16,
    borderRadius: tokens.radius.md,
    alignItems: "center",
  },
  buttonText: { color: tokens.bg, fontSize: 16, fontWeight: "600" },
  error: { color: tokens.accents.rose, fontSize: 14 },
});
