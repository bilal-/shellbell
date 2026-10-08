import type { BackendName } from "@shellbell/protocol";
import { useEffect, useRef, useState } from "react";
import {
  ActivityIndicator,
  Modal,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { connectionManager } from "../net/manager";
import { useConnectionsStore } from "../store/connections";
import { tokens } from "../theme/tokens";
import { sessionCreationOptions } from "../util/backends";

export function NewSessionSheet({
  fp,
  visible,
  onClose,
  onCreated,
}: {
  fp: string;
  visible: boolean;
  onClose: () => void;
  onCreated: (sessionId: string) => void;
}) {
  const conn = useConnectionsStore((s) => s.byComputer[fp]);
  const insets = useSafeAreaInsets();
  const [creating, setCreating] = useState<string | null>(null);
  const creationPending = useRef(false);
  const [error, setError] = useState<string | null>(null);
  const connected = conn?.status === "online" && conn.transport?.ready !== false;
  const options = sessionCreationOptions(
    conn?.hello?.backends ?? [],
    conn?.hello?.launchableBackends ?? [],
    conn?.hello?.backendCatalog,
    conn?.hello?.sessionLaunchTargets,
  );
  useEffect(() => {
    if (visible) setError(null);
  }, [visible]);

  const createSession = async (backend: BackendName, host?: string) => {
    if (creationPending.current) return;
    const connection = connectionManager.get(fp);
    if (!connection?.online) {
      setError("Reconnect to your computer before creating a session.");
      return;
    }
    creationPending.current = true;
    setCreating(`${backend}:${host ?? "default"}`);
    setError(null);
    try {
      const ack = await connection.request({
        type: "session.create",
        reqId: connection.newReqId(),
        in: { kind: "tab", backend, ...(host ? { host } : {}) },
      });
      if (!ack.ok || !ack.sessionId) {
        setError(
          "Could not create a session. Check the terminal app and its local API on your computer.",
        );
        return;
      }
      onClose();
      onCreated(ack.sessionId);
    } catch {
      setError(
        "No response from your computer. Check the session list before trying again; a session may have been created.",
      );
    } finally {
      creationPending.current = false;
      setCreating(null);
    }
  };

  return (
    <Modal
      transparent
      animationType="fade"
      visible={visible}
      supportedOrientations={["portrait", "landscape-left", "landscape-right"]}
      onRequestClose={() => {
        if (creating === null) onClose();
      }}
    >
      <View
        style={[
          styles.overlay,
          {
            paddingBottom: Math.max(16, insets.bottom),
            paddingTop: Math.max(16, insets.top),
            paddingLeft: Math.max(16, insets.left),
            paddingRight: Math.max(16, insets.right),
          },
        ]}
      >
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Dismiss new session"
          disabled={creating !== null}
          accessibilityState={{ disabled: creating !== null }}
          onPress={onClose}
          style={StyleSheet.absoluteFill}
        />
        <View accessibilityViewIsModal style={styles.sheet}>
          <Text accessibilityRole="header" style={styles.title}>
            New session
          </Text>
          <Text style={styles.detail}>
            {connected
              ? "Choose a session, or open one in a terminal window on your computer."
              : "Reconnect to your computer to create a session."}
          </Text>
          <ScrollView contentContainerStyle={styles.options}>
            {options.map((option) => {
              const key = `${option.backend}:${option.host ?? "default"}`;
              const disabled = !connected || !option.available || creating !== null;
              return (
                <Pressable
                  key={key}
                  accessibilityRole="button"
                  accessibilityLabel={option.label}
                  accessibilityHint={option.detail}
                  accessibilityState={{ disabled, busy: creating === key }}
                  disabled={disabled}
                  onPress={() => void createSession(option.backend, option.host)}
                  style={[styles.option, disabled && styles.unavailable]}
                >
                  <View style={styles.optionText}>
                    <Text style={styles.optionTitle}>{option.label}</Text>
                    <Text style={styles.detail}>{option.detail}</Text>
                    {!option.available && <Text style={styles.availability}>Unavailable</Text>}
                  </View>
                  {creating === key && <ActivityIndicator color={tokens.accents.emerald} />}
                </Pressable>
              );
            })}
          </ScrollView>
          {error && (
            <Text accessibilityLiveRegion="polite" style={styles.error}>
              {error}
            </Text>
          )}
          <Pressable
            accessibilityRole="button"
            disabled={creating !== null}
            accessibilityState={{ disabled: creating !== null }}
            onPress={onClose}
            style={styles.cancel}
          >
            <Text style={styles.cancelText}>Cancel</Text>
          </Pressable>
        </View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  overlay: {
    flex: 1,
    justifyContent: "flex-end",
    alignItems: "center",
    paddingHorizontal: 16,
    backgroundColor: "rgba(0,0,0,0.65)",
  },
  sheet: {
    width: "100%",
    maxWidth: 560,
    maxHeight: "90%",
    backgroundColor: tokens.surface2,
    borderRadius: tokens.radius.lg,
    borderWidth: 1,
    borderColor: tokens.border,
    padding: 20,
    gap: 12,
  },
  title: { color: tokens.text, fontSize: 20, fontWeight: "600" },
  detail: { color: tokens.textMuted, fontSize: 13, lineHeight: 19 },
  options: { gap: 10 },
  option: {
    borderWidth: 1,
    borderColor: tokens.border,
    borderRadius: tokens.radius.md,
    backgroundColor: tokens.surface,
    padding: 14,
    minHeight: 72,
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
  },
  optionText: { flex: 1, gap: 4 },
  optionTitle: { color: tokens.text, fontSize: 16, fontWeight: "500" },
  unavailable: { opacity: 0.65 },
  availability: { color: tokens.textMuted, fontSize: 12 },
  error: { color: tokens.accents.rose, fontSize: 13, lineHeight: 19 },
  cancel: { minHeight: 48, alignItems: "center", justifyContent: "center" },
  cancelText: { color: tokens.text, fontSize: 15 },
});
