import { type BackendName, INITIAL_TERMINAL_SIZE_LIMITS as limits } from "@shellbell/protocol";
import { useEffect, useMemo, useRef, useState } from "react";
import {
  ActivityIndicator,
  Keyboard,
  Modal,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  useWindowDimensions,
  View,
} from "react-native";
import { KeyboardAvoidingView } from "react-native-keyboard-controller";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { DeliveryUnknownError } from "../net/connection";
import { connectionManager } from "../net/manager";
import { useCloseWhenHidden } from "../security/screen-hidden";
import { useConnectionsStore } from "../store/connections";
import { customTerminalSize } from "../terminal/initial-size";
import { newSessionSize } from "../terminal/new-session-size";
import { tokens } from "../theme/tokens";
import {
  backendLabel,
  creationErrorText,
  NO_DESKTOP_SESSION_TEXT,
  sessionCreationGroups,
} from "../util/backends";
import { AppIcon } from "./AppIcon";
import { useFocusScope } from "./focus-scope";

export const CONNECTION_DROPPED_TEXT =
  "Connection dropped before the computer answered. Check your computer, then try again.";

type SizeMode = "phone" | "custom" | "default";
const launchKey = (backend: string, host?: string) => `${backend}:${host ?? "default"}`;
const groupsFor = (
  hello: ReturnType<typeof useConnectionsStore.getState>["byComputer"][string]["hello"],
) =>
  sessionCreationGroups(
    hello?.backends ?? [],
    hello?.launchableBackends ?? [],
    hello?.backendCatalog,
    hello?.sessionLaunchTargets,
    hello?.sessionLaunchIssues,
  );

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
  const hidden = useCloseWhenHidden(visible, onClose);
  const conn = useConnectionsStore((s) => s.byComputer[fp]);
  const insets = useSafeAreaInsets();
  const window = useWindowDimensions();
  const [keyboardVisible, setKeyboardVisible] = useState(Keyboard.isVisible());
  const openContext = useMemo(() => ({ fp, visible }), [fp, visible]);
  const latestContext = useRef(openContext);
  latestContext.current = openContext;
  const [creating, setCreating] = useState(false);
  const creationPending = useRef(false);
  const focus = useFocusScope();
  const [error, setError] = useState<string | null>(null);
  const [engine, setEngine] = useState<BackendName | null>(null);
  const [destination, setDestination] = useState<string | null>(null);
  const [sizeMode, setSizeMode] = useState<SizeMode>("phone");
  const [phoneSize, setPhoneSize] = useState(() => newSessionSize(insets));
  const [cols, setCols] = useState("");
  const [rows, setRows] = useState("");
  const connected = conn?.status === "online" && conn.transport?.ready !== false;
  const groups = groupsFor(conn?.hello);
  const group = groups.find((entry) => entry.backend === engine);
  const launch = group?.launches.find(
    (entry) => launchKey(entry.backend, entry.host) === destination,
  );
  const size =
    sizeMode === "phone"
      ? phoneSize
      : sizeMode === "custom"
        ? customTerminalSize(cols, rows)
        : undefined;
  const sizeValid = sizeMode === "default" || size !== undefined;
  const canCreate =
    connected &&
    Boolean(launch) &&
    sizeValid &&
    !creating &&
    !(sizeMode === "phone" && keyboardVisible);
  const compact = window.height < 500;

  useEffect(() => {
    const shown = Keyboard.addListener("keyboardDidShow", () => setKeyboardVisible(true));
    const hidden = Keyboard.addListener("keyboardDidHide", () => setKeyboardVisible(false));
    return () => {
      shown.remove();
      hidden.remove();
    };
  }, []);

  useEffect(() => {
    if (!visible || !fp) return;
    setEngine(null);
    setDestination(null);
    setSizeMode("phone");
    setError(null);
  }, [visible, fp]);

  useEffect(() => {
    if (!visible || keyboardVisible || Keyboard.isVisible()) return;
    // Capture the reading area before the custom-size keyboard opens. Rotation
    // and window changes refresh the estimate; typing cannot shrink it.
    setPhoneSize(
      newSessionSize(
        {
          top: insets.top,
          bottom: insets.bottom,
          left: insets.left,
          right: insets.right,
        },
        { width: window.width, height: window.height },
      ),
    );
  }, [
    visible,
    keyboardVisible,
    window.width,
    window.height,
    insets.top,
    insets.bottom,
    insets.left,
    insets.right,
  ]);

  const chooseSize = (mode: SizeMode) => {
    if (creating) return;
    Keyboard.dismiss();
    if (mode === "custom" && sizeMode !== "custom") {
      setCols(String(size?.cols ?? phoneSize?.cols ?? 80));
      setRows(String(size?.rows ?? phoneSize?.rows ?? 24));
    }
    setSizeMode(mode);
    setError(null);
  };
  const back = () => {
    if (creating) return;
    Keyboard.dismiss();
    setEngine(null);
    setDestination(null);
    setError(null);
  };
  const close = () => {
    if (creating) return;
    Keyboard.dismiss();
    onClose();
  };
  const createSession = async () => {
    if (creationPending.current) return;
    const current = useConnectionsStore.getState().byComputer[fp];
    const connection = connectionManager.get(fp);
    if (!connection?.online || current?.status !== "online" || current.transport?.ready === false) {
      setError("Reconnect to your computer before creating a session.");
      return;
    }
    // Discovery can change while the sheet is open. Never substitute a different host.
    const selected = groupsFor(current.hello)
      .find((entry) => entry.backend === engine)
      ?.launches.find((entry) => launchKey(entry.backend, entry.host) === destination);
    if (!selected) {
      setError("Choose an available terminal app before creating a session.");
      return;
    }
    if (!sizeValid || (sizeMode === "phone" && keyboardVisible)) return;
    creationPending.current = true;
    const focused = focus.start();
    const requestContext = openContext;
    Keyboard.dismiss();
    setCreating(true);
    setError(null);
    try {
      const ack = await connection.request({
        type: "session.create",
        reqId: connection.newReqId(),
        in: {
          kind: "tab",
          backend: selected.backend,
          ...(selected.host ? { host: selected.host } : {}),
          ...(size ? { initialSize: size } : {}),
        },
      });
      if (latestContext.current !== requestContext) return;
      if (!ack.ok || !ack.sessionId) {
        setError(
          creationErrorText(ack.error) ??
            "Could not create a session. Check the terminal app and its local API on your computer.",
        );
        return;
      }
      onClose();
      // The person moved on meanwhile; the session exists and appears in its list.
      if (focused()) onCreated(ack.sessionId);
    } catch (failure) {
      if (latestContext.current !== requestContext) return;
      // Never retried automatically: the computer may already have opened the window.
      setError(
        failure instanceof DeliveryUnknownError
          ? CONNECTION_DROPPED_TEXT
          : "No response from your computer. Check the session list before trying again; a session may have been created.",
      );
    } finally {
      creationPending.current = false;
      setCreating(false);
    }
  };

  const actions = (
    <>
      {engine && (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Create window"
          accessibilityState={{ disabled: !canCreate, busy: creating }}
          disabled={!canCreate}
          onPress={() => void createSession()}
          style={[styles.create, !canCreate && styles.unavailable]}
        >
          {creating ? (
            <ActivityIndicator color={tokens.bg} />
          ) : (
            <Text style={styles.createText}>Create window</Text>
          )}
        </Pressable>
      )}
      <Pressable
        accessibilityRole="button"
        accessibilityLabel="Cancel new session"
        disabled={creating}
        accessibilityState={{ disabled: creating }}
        onPress={close}
        style={styles.cancel}
      >
        <Text style={styles.cancelText}>Cancel</Text>
      </Pressable>
    </>
  );

  return (
    <Modal
      transparent
      animationType="fade"
      visible={visible && !hidden}
      supportedOrientations={["portrait", "landscape-left", "landscape-right"]}
      onRequestClose={() => {
        if (Keyboard.isVisible()) Keyboard.dismiss();
        else if (engine && !creating) back();
        else close();
      }}
    >
      <KeyboardAvoidingView behavior="padding" style={styles.overlay}>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Dismiss new session"
          disabled={creating}
          accessibilityState={{ disabled: creating }}
          onPress={() => {
            if (Keyboard.isVisible()) Keyboard.dismiss();
            else close();
          }}
          style={StyleSheet.absoluteFill}
        />
        <View
          pointerEvents="box-none"
          style={[
            styles.safeArea,
            {
              paddingBottom: Math.max(16, insets.bottom),
              paddingTop: Math.max(16, insets.top),
              paddingLeft: Math.max(16, insets.left),
              paddingRight: Math.max(16, insets.right),
            },
          ]}
        >
          <View accessibilityViewIsModal style={styles.sheet}>
            <View style={styles.heading}>
              {engine && (
                <Pressable
                  accessibilityRole="button"
                  accessibilityLabel="Back to terminal choices"
                  onPress={back}
                  disabled={creating}
                  accessibilityState={{ disabled: creating }}
                  style={styles.back}
                >
                  <AppIcon name="left" />
                </Pressable>
              )}
              <Text accessibilityRole="header" style={styles.title}>
                {engine
                  ? `New ${group?.label ?? backendLabel(engine, conn?.hello?.backendCatalog)} session`
                  : "New session"}
              </Text>
            </View>
            {!connected && (
              <Text style={styles.detail}>Reconnect to your computer to create a session.</Text>
            )}
            {creating && !engine && (
              <Text style={styles.detail}>Waiting for the previous window to finish opening…</Text>
            )}
            <ScrollView
              key={engine ?? "engines"}
              keyboardShouldPersistTaps="handled"
              contentContainerStyle={styles.content}
            >
              {!engine ? (
                <>
                  <Text style={styles.detail}>Choose a terminal, then where to open it.</Text>
                  {connected && !groups.some((entry) => entry.available) && (
                    <Text style={styles.detail}>{NO_DESKTOP_SESSION_TEXT}</Text>
                  )}
                  {groups.map((entry) => {
                    const disabled = !connected || !entry.available || creating;
                    return (
                      <Pressable
                        key={entry.backend}
                        accessibilityRole="button"
                        accessibilityLabel={entry.label}
                        accessibilityHint={entry.detail}
                        accessibilityState={{ disabled }}
                        disabled={disabled}
                        onPress={() => {
                          setEngine(entry.backend);
                          const first = entry.launches[0];
                          setDestination(first ? launchKey(first.backend, first.host) : null);
                          setError(null);
                        }}
                        style={[styles.engine, disabled && styles.unavailable]}
                      >
                        <View style={styles.optionText}>
                          <Text style={styles.optionTitle}>{entry.label}</Text>
                          <Text style={styles.detail}>{entry.detail}</Text>
                        </View>
                        {entry.available && <AppIcon name="right" color={tokens.textMuted} />}
                      </Pressable>
                    );
                  })}
                </>
              ) : (
                <>
                  <Text style={styles.sectionTitle}>Open in</Text>
                  {group?.launches.map((entry) => {
                    const key = launchKey(entry.backend, entry.host);
                    const selected = key === destination;
                    return (
                      <Pressable
                        key={key}
                        accessibilityRole="radio"
                        accessibilityLabel={entry.hostLabel}
                        accessibilityState={{ selected, disabled: creating || !connected }}
                        disabled={creating || !connected}
                        onPress={() => {
                          setDestination(key);
                          setError(null);
                        }}
                        style={[styles.choice, selected && styles.selected]}
                      >
                        <Text style={styles.optionTitle}>{entry.hostLabel}</Text>
                        {selected && <AppIcon name="check" color={tokens.accents.emerald} />}
                      </Pressable>
                    );
                  })}
                  {!launch && (
                    <Text accessibilityLiveRegion="polite" style={styles.detail}>
                      This launch option is no longer available. Choose another app or go back.
                    </Text>
                  )}
                  <Text style={styles.detail}>Opens a new window on your computer.</Text>
                  <View style={styles.sizeHeading}>
                    <Text style={styles.sectionTitle}>Window size</Text>
                    {keyboardVisible && sizeMode === "custom" && (
                      <Pressable
                        accessibilityRole="button"
                        accessibilityLabel="Done editing window size"
                        onPress={Keyboard.dismiss}
                        style={styles.done}
                      >
                        <Text style={styles.doneText}>Done</Text>
                      </Pressable>
                    )}
                  </View>
                  <View style={styles.sizeChoices}>
                    {(
                      [
                        ["phone", "Fit phone"],
                        ["custom", "Custom"],
                        ["default", "Computer default"],
                      ] as const
                    ).map(([mode, label]) => (
                      <Pressable
                        key={mode}
                        accessibilityRole="radio"
                        accessibilityLabel={label}
                        accessibilityState={{ selected: sizeMode === mode, disabled: creating }}
                        disabled={creating}
                        onPress={() => chooseSize(mode)}
                        style={[styles.sizeChoice, sizeMode === mode && styles.selected]}
                      >
                        <Text style={styles.choiceText}>{label}</Text>
                      </Pressable>
                    ))}
                  </View>
                  {sizeMode === "custom" && (
                    <View style={styles.dimensions}>
                      <View style={styles.dimension}>
                        <Text style={styles.detail}>Columns</Text>
                        <TextInput
                          accessibilityLabel="Window columns"
                          value={cols}
                          onChangeText={setCols}
                          editable={!creating}
                          keyboardType="number-pad"
                          disableFullscreenUI
                          selectTextOnFocus
                          maxLength={3}
                          onSubmitEditing={Keyboard.dismiss}
                          style={styles.numberInput}
                        />
                      </View>
                      <View style={styles.dimension}>
                        <Text style={styles.detail}>Rows</Text>
                        <TextInput
                          accessibilityLabel="Window rows"
                          value={rows}
                          onChangeText={setRows}
                          editable={!creating}
                          keyboardType="number-pad"
                          disableFullscreenUI
                          selectTextOnFocus
                          maxLength={3}
                          onSubmitEditing={Keyboard.dismiss}
                          style={styles.numberInput}
                        />
                      </View>
                    </View>
                  )}
                  {size ? (
                    <View style={styles.sizeSummary}>
                      <Text style={styles.sizePreview}>
                        Requested: {size.cols} columns × {size.rows} rows
                      </Text>
                      <Text style={styles.detail}>The terminal app may adjust this size.</Text>
                    </View>
                  ) : sizeMode === "custom" ? (
                    <Text accessibilityLiveRegion="polite" style={styles.error}>
                      Use {limits.minCols}–{limits.maxCols} columns and {limits.minRows}–
                      {limits.maxRows} rows.
                    </Text>
                  ) : sizeMode === "phone" ? (
                    <Text style={styles.detail}>
                      Phone size is unavailable. Choose Custom or Computer default.
                    </Text>
                  ) : null}
                  <Text style={styles.detail}>
                    {sizeMode === "phone"
                      ? size && (size.cols === limits.minCols || size.rows === limits.minRows)
                        ? "Closest supported fit. Your font size or screen height may still require scrolling."
                        : "Sized for this phone’s reading area with the keyboard closed."
                      : sizeMode === "custom"
                        ? "Width and height in text cells. Wider windows may need sideways scrolling."
                        : "Uses the terminal app’s window size on your computer."}
                  </Text>
                </>
              )}
              {error && (
                <Text accessibilityLiveRegion="polite" style={styles.error}>
                  {error}
                </Text>
              )}
              {compact && actions}
            </ScrollView>
            {!compact && actions}
          </View>
        </View>
      </KeyboardAvoidingView>
    </Modal>
  );
}

const styles = StyleSheet.create({
  overlay: {
    flex: 1,
    backgroundColor: "rgba(0,0,0,0.65)",
  },
  safeArea: {
    flex: 1,
    justifyContent: "flex-end",
    alignItems: "center",
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
  heading: { flexDirection: "row", alignItems: "center", gap: 8 },
  back: {
    minWidth: 44,
    minHeight: 44,
    alignItems: "center",
    justifyContent: "center",
    marginLeft: -8,
  },
  title: { color: tokens.text, fontSize: 20, fontWeight: "600", flexShrink: 1 },
  detail: { color: tokens.textMuted, fontSize: 13, lineHeight: 19 },
  content: { gap: 10, paddingBottom: 4 },
  engine: {
    borderBottomWidth: 1,
    borderColor: tokens.border,
    paddingVertical: 14,
    minHeight: 76,
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
  },
  optionText: { flex: 1, gap: 4 },
  optionTitle: { color: tokens.text, fontSize: 16, fontWeight: "500" },
  sectionTitle: { color: tokens.text, fontSize: 14, fontWeight: "600", marginTop: 8 },
  choice: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: 12,
    borderWidth: 1,
    borderColor: tokens.border,
    borderRadius: tokens.radius.sm,
    paddingHorizontal: 14,
    minHeight: 48,
  },
  selected: { borderColor: tokens.accents.emerald, backgroundColor: tokens.surface },
  sizeHeading: { flexDirection: "row", alignItems: "center", justifyContent: "space-between" },
  done: { minWidth: 48, minHeight: 44, alignItems: "center", justifyContent: "center" },
  doneText: { color: tokens.accents.emerald, fontSize: 14 },
  sizeChoices: { flexDirection: "row", flexWrap: "wrap", gap: 8 },
  sizeChoice: {
    borderWidth: 1,
    borderColor: tokens.border,
    borderRadius: tokens.radius.sm,
    minHeight: 48,
    paddingHorizontal: 12,
    justifyContent: "center",
  },
  choiceText: { color: tokens.text, fontSize: 14 },
  dimensions: { flexDirection: "row", gap: 12 },
  dimension: { flex: 1, gap: 6 },
  numberInput: {
    borderWidth: 1,
    borderColor: tokens.border,
    borderRadius: tokens.radius.sm,
    backgroundColor: tokens.surface,
    color: tokens.text,
    fontSize: 18,
    minHeight: 48,
    paddingHorizontal: 12,
  },
  sizePreview: { color: tokens.text, fontSize: 16, lineHeight: 23 },
  sizeSummary: { gap: 4 },
  unavailable: { opacity: 0.55 },
  error: { color: tokens.accents.rose, fontSize: 13, lineHeight: 19 },
  create: {
    minHeight: 48,
    borderRadius: tokens.radius.md,
    backgroundColor: tokens.accents.emerald,
    alignItems: "center",
    justifyContent: "center",
  },
  createText: { color: tokens.bg, fontSize: 16, fontWeight: "600" },
  cancel: { minHeight: 44, alignItems: "center", justifyContent: "center" },
  cancelText: { color: tokens.text, fontSize: 15 },
});
