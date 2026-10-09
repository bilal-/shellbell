import type { NamedKey } from "@shellbell/protocol";
import * as Clipboard from "expo-clipboard";
import * as Haptics from "expo-haptics";
import { type ReactNode, useEffect, useRef, useState } from "react";
import { Keyboard, Modal, Pressable, ScrollView, Text, TextInput, View } from "react-native";
import { SafeAreaProvider, useSafeAreaInsets } from "react-native-safe-area-context";
import { connectionManager } from "../net/manager";
import { pendingInputHooks, useConnectionsStore } from "../store/connections";
import type { TerminalControls } from "../terminal/controls";
import { tokens } from "../theme/tokens";
import { AppIcon } from "../ui/AppIcon";
import { Bar } from "../ui/Bar";
import { type ComposedInputResult, fireInput, INPUT_DELIVERY_UNKNOWN } from "./fireInput";
import { clampInputHeight, INPUT_MIN_HEIGHT } from "./height";
import { COMPOSER_IME } from "./imeProps";
import { keyPresentation } from "./keyPresentation";
import { composerLayout } from "./layout";
import { inputTextExceedsLimit, lineExceedsLimit } from "./limits";
import { QuickKeys } from "./QuickKeys";
import { ReplyChips } from "./ReplyChips";

function KeyGuideSafeArea({ children }: { children: ReactNode }) {
  const insets = useSafeAreaInsets();
  return (
    <View
      style={{
        flex: 1,
        backgroundColor: tokens.bg,
        paddingTop: insets.top,
        paddingBottom: insets.bottom,
        paddingLeft: insets.left,
        paddingRight: insets.right,
      }}
    >
      {children}
    </View>
  );
}

/** xterm owns live keyboard/IME input. This bar adds unavailable phone keys and an optional draft. */
export function InputBar({
  fp,
  sessionId,
  accent,
  showChips,
  availableHeight = null,
  terminalControls,
  hardwareKeyboard = false,
  onSubmitLine,
}: {
  fp: string;
  sessionId: string;
  accent: string;
  showChips: boolean;
  availableHeight?: number | null;
  terminalControls?: TerminalControls;
  hardwareKeyboard?: boolean;
  onSubmitLine?: (line: string, reqId: string) => Promise<ComposedInputResult>;
}) {
  const connected = useConnectionsStore(
    (s) => s.byComputer[fp]?.status === "online" && s.byComputer[fp]?.transport?.ready !== false,
  );
  const hostPlatform = useConnectionsStore((s) => s.byComputer[fp]?.hello?.hostPlatform);
  const presentation = keyPresentation(hostPlatform);
  const [composing, setComposing] = useState(false);
  const focusTerminalAfterDraft = useRef(false);
  const [submitting, setSubmitting] = useState(false);
  const submission = useRef(false);
  const mounted = useRef(true);
  const retry = useRef<{ line: string; reqId: string } | null>(null);
  const [text, setText] = useState("");
  const [histIdx, setHistIdx] = useState(-1);
  const [inputHeight, setInputHeight] = useState(INPUT_MIN_HEIGHT);
  const [keysOpen, setKeysOpen] = useState(false);
  const layout = composerLayout(availableHeight, inputHeight, showChips);
  const ime = COMPOSER_IME;
  const conn = () => connectionManager.get(fp);
  type Req = Parameters<NonNullable<ReturnType<typeof conn>>["request"]>[0];
  const toast = (message: string) =>
    useConnectionsStore.getState().patch(fp, () => ({ toast: message }));

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  useEffect(() => {
    if (hardwareKeyboard) {
      setKeysOpen(false);
      if (terminalControls) {
        if (composing) {
          focusTerminalAfterDraft.current = true;
          setComposing(false);
        } else {
          focusTerminalAfterDraft.current = false;
          terminalControls.command({ type: "focus" });
        }
      }
    } else if (!composing && focusTerminalAfterDraft.current) {
      focusTerminalAfterDraft.current = false;
      terminalControls?.command({ type: "focus" });
    }
  }, [hardwareKeyboard, terminalControls, composing]);

  const fire = (msg: Req): Promise<unknown> | null => {
    const c = conn();
    if (!connected || !c?.online) return null;
    if (msg.type === "input.text" && inputTextExceedsLimit(msg)) {
      toast("Input too large — paste or type a smaller chunk.");
      return null;
    }
    void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    return fireInput(c, msg, pendingInputHooks(fp, sessionId));
  };
  const sendKey = (key: NamedKey) => {
    const c = conn();
    return c ? Boolean(fire({ type: "input.key", reqId: c.newReqId(), sessionId, key })) : false;
  };
  const sendText = (data: string) => {
    if (!connected) return false;
    if (terminalControls) return terminalControls.command({ type: "input", data });
    const c = conn();
    return Boolean(
      c && data && fire({ type: "input.text", reqId: c.newReqId(), sessionId, text: data }),
    );
  };
  const sendLine = async (line: string): Promise<boolean> => {
    if (!connected || submission.current) return false;
    if (lineExceedsLimit(line)) {
      toast("Line too long — shorten it before sending.");
      return false;
    }
    const c = conn();
    if (!c?.online) return false;
    // Explicit retries keep their identity while delivery is unconfirmed.
    if (retry.current?.line !== line) retry.current = { line, reqId: c.newReqId() };
    const { reqId } = retry.current;
    submission.current = true;
    setSubmitting(true);
    try {
      const outcome = onSubmitLine
        ? await onSubmitLine(line, reqId)
        : terminalControls
          ? null
          : await fire({ type: "input.line", reqId, sessionId, text: line });
      if (outcome === INPUT_DELIVERY_UNKNOWN) {
        toast("Delivery unconfirmed. Check the terminal before retrying; it may already have run.");
        return false;
      }
      retry.current = null;
      const accepted =
        outcome === true ||
        (typeof outcome === "object" && outcome !== null && "ok" in outcome && outcome.ok === true);
      if (accepted)
        useConnectionsStore.getState().patch(fp, (state) => ({
          history: [...state.history.filter((item) => item !== line), line].slice(-100),
        }));
      return accepted;
    } catch {
      toast("Command was not sent. Your draft is retained.");
      return false;
    } finally {
      submission.current = false;
      setSubmitting(false);
    }
  };
  const paste = async () => {
    try {
      const value = await Clipboard.getStringAsync();
      if (!mounted.current || !connected || !value) return;
      if (terminalControls) terminalControls.command({ type: "paste", text: value });
      else {
        setText(value);
        setComposing(true);
      } // Older hosts: review, then explicitly send.
    } catch {
      toast("Could not read the clipboard. Try again.");
    }
  };
  const openKeys = () => {
    Keyboard.dismiss();
    setKeysOpen(true);
  };
  const browseHistory = () => {
    const history = useConnectionsStore.getState().read(fp).history;
    if (!history.length) return;
    const index = histIdx === -1 ? history.length - 1 : Math.max(0, histIdx - 1);
    setHistIdx(index);
    setText(history[index] ?? "");
  };
  const submit = async () => {
    const line = text;
    if (!line.trim() || !(await sendLine(line))) return;
    setText((current) => (current === line ? "" : current));
    setHistIdx(-1);
    setInputHeight(INPUT_MIN_HEIGHT);
  };
  const typeDirectly = () => {
    if (composing) {
      focusTerminalAfterDraft.current = true;
      setComposing(false);
    } else {
      terminalControls?.command({ type: "focus" });
    }
  };
  const draftCommand = () => {
    terminalControls?.command({ type: "blur" });
    setComposing(true);
  };
  const keys = (guide = false) => (
    <QuickKeys
      key={`${guide ? "guide" : "bar"}:${fp}:${sessionId}`}
      disabled={!connected}
      hostPlatform={hostPlatform}
      onKey={sendKey}
      onText={sendText}
      onPaste={() => void paste()}
      onGuide={guide ? undefined : openKeys}
      onKeyboard={!guide && terminalControls ? typeDirectly : undefined}
      onCompose={!guide && terminalControls ? draftCommand : undefined}
      draftActive={composing}
    />
  );

  // Hide every keyboard accessory, including an already-open guide, on physical attachment.
  if (hardwareKeyboard && terminalControls) return null;
  return (
    <>
      <Bar
        style={{ gap: 4 }}
        verticalPadding={composing || !terminalControls ? layout.verticalPadding : 4}
      >
        {terminalControls && !composing ? (
          keys()
        ) : (
          <>
            {!layout.compact && !hardwareKeyboard ? keys() : null}
            {showChips && !layout.compact && !hardwareKeyboard ? (
              <ReplyChips
                onLine={sendLine}
                onKey={sendKey}
                enterLabel={presentation.enterLabel}
                disabled={!connected || submitting}
              />
            ) : null}
            <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
              {layout.compact && !hardwareKeyboard ? (
                <Pressable
                  accessibilityRole="button"
                  accessibilityLabel="Terminal keys"
                  onPress={openKeys}
                  style={{ padding: 10, minHeight: 44 }}
                >
                  <Text style={{ color: accent }}>Keys</Text>
                </Pressable>
              ) : null}
              <View
                style={{
                  flex: 1,
                  flexDirection: "row",
                  alignItems: "flex-end",
                  backgroundColor: tokens.surface2,
                  borderRadius: 16,
                  borderWidth: 1,
                  borderColor: tokens.border,
                  paddingLeft: 12,
                }}
              >
                <Text
                  style={{
                    color: tokens.textMuted,
                    fontWeight: "700",
                    lineHeight: INPUT_MIN_HEIGHT,
                  }}
                >
                  $
                </Text>
                <TextInput
                  accessibilityLabel="Command draft"
                  autoFocus={Boolean(terminalControls)}
                  value={text}
                  editable={!submitting}
                  onChangeText={(value) => {
                    setText(value);
                    setHistIdx(-1);
                  }}
                  onSubmitEditing={submit}
                  blurOnSubmit={false}
                  multiline
                  submitBehavior="submit"
                  disableFullscreenUI
                  onContentSizeChange={(event) =>
                    setInputHeight(clampInputHeight(event.nativeEvent.contentSize.height))
                  }
                  placeholder="Draft a command, then send"
                  placeholderTextColor={tokens.textFaint}
                  autoCorrect={ime.autoCorrect}
                  autoCapitalize={ime.autoCapitalize}
                  spellCheck={ime.spellCheck}
                  autoComplete={ime.autoComplete}
                  textContentType="none"
                  keyboardType={ime.keyboardType}
                  returnKeyType="send"
                  style={{
                    flex: 1,
                    color: tokens.text,
                    paddingVertical: 10,
                    paddingHorizontal: 8,
                    fontSize: 15,
                    height: layout.inputHeight,
                    textAlignVertical: "center",
                  }}
                />
                <Pressable
                  accessibilityRole="button"
                  accessibilityLabel="Previous command"
                  onPress={browseHistory}
                  style={{ padding: 12, minHeight: 44 }}
                >
                  <AppIcon name="up" color={tokens.textMuted} />
                </Pressable>
              </View>
              <Pressable
                accessibilityRole="button"
                accessibilityLabel="Send"
                disabled={!connected || !text.trim() || submitting}
                accessibilityState={{ disabled: !connected || !text.trim() || submitting }}
                onPress={submit}
                style={{
                  width: 44,
                  height: 44,
                  borderRadius: tokens.radius.md,
                  backgroundColor: connected && text.trim() ? accent : tokens.surface2,
                  alignItems: "center",
                  justifyContent: "center",
                }}
              >
                <AppIcon
                  name="return"
                  color={connected && text.trim() ? tokens.bg : tokens.textFaint}
                />
              </Pressable>
            </View>
            {terminalControls && layout.compact ? (
              <Pressable
                accessibilityRole="button"
                accessibilityLabel="Type directly"
                onPress={typeDirectly}
                style={{ padding: 8 }}
              >
                <Text style={{ color: accent }}>Type directly</Text>
              </Pressable>
            ) : null}
          </>
        )}
      </Bar>
      <Modal
        visible={keysOpen && !hardwareKeyboard}
        animationType="slide"
        supportedOrientations={["portrait", "landscape-left", "landscape-right"]}
        onRequestClose={() => setKeysOpen(false)}
      >
        <SafeAreaProvider>
          <KeyGuideSafeArea>
            <ScrollView
              keyboardShouldPersistTaps="always"
              keyboardDismissMode="none"
              contentContainerStyle={{ padding: 16, gap: 16 }}
            >
              <View
                style={{
                  flexDirection: "row",
                  alignItems: "center",
                  justifyContent: "space-between",
                }}
              >
                <Text accessibilityRole="header" style={{ color: tokens.text, fontSize: 20 }}>
                  Terminal keys
                </Text>
                <Pressable
                  accessibilityRole="button"
                  accessibilityLabel="Done"
                  onPress={() => setKeysOpen(false)}
                  style={{ padding: 12, minHeight: 48 }}
                >
                  <Text style={{ color: accent, fontSize: 16 }}>Done</Text>
                </Pressable>
              </View>
              <Text style={{ color: tokens.textMuted, fontSize: 15 }}>
                Keys are sent to this terminal. Your unsent command draft stays on this phone.
              </Text>
              <Text style={{ color: tokens.text, fontSize: 15 }}>{presentation.hostLabel}</Text>
              <Text style={{ color: tokens.textMuted, fontSize: 15 }}>{presentation.guide}</Text>
              {showChips ? (
                <ReplyChips
                  onLine={sendLine}
                  onKey={sendKey}
                  enterLabel={presentation.enterLabel}
                  disabled={!connected || submitting}
                />
              ) : null}
              {keys(true)}
            </ScrollView>
          </KeyGuideSafeArea>
        </SafeAreaProvider>
      </Modal>
    </>
  );
}
