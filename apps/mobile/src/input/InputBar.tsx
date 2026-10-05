import type { NamedKey } from "@shellbell/protocol";
import * as Clipboard from "expo-clipboard";
import * as Haptics from "expo-haptics";
import { type ReactNode, useRef, useState } from "react";
import {
  Keyboard,
  Modal,
  Platform,
  Pressable,
  ScrollView,
  Text,
  TextInput,
  View,
} from "react-native";
import { SafeAreaProvider, useSafeAreaInsets } from "react-native-safe-area-context";
import { connectionManager } from "../net/manager";
import { useUiStore } from "../store/computers";
import { useConnectionsStore } from "../store/connections";
import { tokens } from "../theme/tokens";
import { Bar } from "../ui/Bar";
import { fireInput } from "./fireInput";
import { clampInputHeight, INPUT_MIN_HEIGHT } from "./height";
import { imeProps } from "./imeProps";
import { keyPresentation } from "./keyPresentation";
import { composerLayout } from "./layout";
import { lineExceedsLimit } from "./limits";
import { preparePaste } from "./paste";
import { QuickKeys } from "./QuickKeys";
import { ReplyChips } from "./ReplyChips";
import { type RawStep, rawBackspaceOnEmptySteps, rawChangeSteps } from "./rawSequence";

const LINE_TOO_LONG_TOAST = "Line too long — shorten it before sending.";

// Native modals have their own window geometry, especially beside Android's
// landscape navigation bar. Consume the provider inside that window, not the
// screen's inherited measurements. The composer keeps its screen-level insets.
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

export function InputBar({
  fp,
  sessionId,
  accent,
  showChips,
  availableHeight = null,
}: {
  fp: string;
  sessionId: string;
  accent: string;
  showChips: boolean;
  availableHeight?: number | null;
}) {
  const raw = useUiStore((s) => s.rawModeBySession[sessionId] ?? false);
  const connected = useConnectionsStore(
    (s) => s.byComputer[fp]?.status === "online" && s.byComputer[fp]?.transport?.ready !== false,
  );
  const hostPlatform = useConnectionsStore((s) => s.byComputer[fp]?.hello?.hostPlatform);
  const presentation = keyPresentation(hostPlatform);
  const setRaw = useUiStore((s) => s.setRawMode);
  const ime = imeProps(raw ? "raw" : "line", Platform.OS === "ios" ? "ios" : "android");
  const [text, setText] = useState("");
  const [rawText, setRawText] = useState("");
  const [histIdx, setHistIdx] = useState(-1);
  const [inputHeight, setInputHeight] = useState(INPUT_MIN_HEIGHT);
  const rawPrev = useRef("");
  const [keysOpen, setKeysOpen] = useState(false);
  const openKeys = () => {
    Keyboard.dismiss();
    setKeysOpen(true);
  };
  const layout = composerLayout(availableHeight, raw ? INPUT_MIN_HEIGHT : inputHeight, showChips);

  const conn = () => connectionManager.get(fp);

  type Req = Parameters<NonNullable<ReturnType<typeof conn>>["request"]>[0];
  const fire = (msg: Req): boolean => {
    const c = conn();
    if (!c?.online) return false;
    void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    fireInput(c, msg, {
      track: (reqId) =>
        useConnectionsStore.getState().patch(fp, (x) => ({
          pendingInputs: { ...x.pendingInputs, [reqId]: { at: Date.now(), sessionId } },
        })),
      untrack: (reqId, toast) =>
        useConnectionsStore.getState().patch(fp, (x) => {
          const rest = { ...x.pendingInputs };
          delete rest[reqId];
          return toast ? { pendingInputs: rest, toast } : { pendingInputs: rest };
        }),
    });
    return true;
  };

  const fireStep = (step: RawStep) => {
    const c = conn();
    if (!c) return;
    if (step.kind === "text")
      fire({ type: "input.text", reqId: c.newReqId(), sessionId, text: step.text });
    else fire({ type: "input.key", reqId: c.newReqId(), sessionId, key: step.key });
  };

  const sendLine = (line: string) => {
    const c = conn();
    if (!c || !fire({ type: "input.line", reqId: c.newReqId(), sessionId, text: line }))
      return false;
    useConnectionsStore.getState().patch(fp, (x) => ({
      history: [...x.history.filter((h) => h !== line), line].slice(-100),
    }));
    return true;
  };
  const sendKey = (key: NamedKey) => {
    const c = conn();
    return c ? fire({ type: "input.key", reqId: c.newReqId(), sessionId, key }) : false;
  };
  const sendText = (t: string) => {
    const c = conn();
    return c && t ? fire({ type: "input.text", reqId: c.newReqId(), sessionId, text: t }) : false;
  };
  const paste = async () => {
    const { text: pasted, sendEnter } = preparePaste(await Clipboard.getStringAsync());
    if (pasted && !sendText(pasted)) return;
    if (sendEnter) sendKey("enter");
  };

  const browseHistory = () => {
    const h = useConnectionsStore.getState().read(fp).history;
    if (h.length === 0) return;
    const idx = histIdx === -1 ? h.length - 1 : Math.max(0, histIdx - 1);
    setHistIdx(idx);
    setText(h[idx] ?? "");
  };

  /** Raw mode: diff against the previous value, then keep it as the new baseline. */
  const onRawChange = (next: string) => {
    if (!conn()?.online) return;
    for (const step of rawChangeSteps(rawPrev.current, next)) fireStep(step);
    rawPrev.current = next;
    setRawText(next);
  };

  /** Review I1: once the field is empty, `onChangeText` never fires for a Backspace press -- the
   *  differ above has nothing left to shorten. `onKeyPress` is the only remaining signal. */
  const onRawKeyPress = (key: string) => {
    if (key !== "Backspace") return;
    for (const step of rawBackspaceOnEmptySteps(rawText)) fireStep(step);
  };

  const submitRaw = () => {
    if (!sendKey("enter")) return;
    rawPrev.current = "";
    setRawText("");
  };

  const submitLine = () => {
    if (!text.trim()) return;
    if (lineExceedsLimit(text)) {
      useConnectionsStore.getState().patch(fp, () => ({ toast: LINE_TOO_LONG_TOAST }));
      return;
    }
    if (!sendLine(text)) return;
    setText("");
    setHistIdx(-1);
    // The field is empty again, so collapse the bar without waiting for a layout pass.
    setInputHeight(INPUT_MIN_HEIGHT);
  };

  return (
    <>
      <Bar style={{ gap: 6 }} verticalPadding={layout.verticalPadding}>
        {showChips && !layout.compact ? <ReplyChips onLine={sendLine} onKey={sendKey} /> : null}
        {!layout.compact ? (
          <QuickKeys
            disabled={!connected}
            hostPlatform={hostPlatform}
            onKey={sendKey}
            onPaste={() => void paste()}
            onGuide={openKeys}
          />
        ) : null}
        <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
          <Pressable
            accessibilityLabel={
              layout.compact ? "Terminal keys" : raw ? "Switch to line mode" : "Switch to raw mode"
            }
            onPress={() => {
              if (layout.compact) {
                openKeys();
              } else setRaw(sessionId, !raw);
            }}
            style={{
              width: 40,
              height: 40,
              borderRadius: tokens.radius.md,
              borderWidth: 1,
              borderColor: raw ? tokens.text : tokens.border,
              alignItems: "center",
              justifyContent: "center",
            }}
          >
            <Text style={{ color: raw ? tokens.text : tokens.textMuted, fontSize: 13 }}>
              {layout.compact ? "Keys" : "⌨︎"}
            </Text>
          </Pressable>
          <View
            style={{
              flex: 1,
              flexDirection: "row",
              // Multi-line input grows downward, so the `$` and the history arrow sit at the bottom
              // with the last line rather than floating beside the middle of the text.
              alignItems: raw ? "center" : "flex-end",
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
                // Keeps the prompt glyph on the baseline of the last line as the field grows.
                lineHeight: raw ? undefined : INPUT_MIN_HEIGHT,
              }}
            >
              {raw ? "»" : "$"}
            </Text>
            <TextInput
              editable={!raw || connected}
              value={raw ? rawText : text}
              onChangeText={
                raw
                  ? onRawChange
                  : (t) => {
                      setText(t);
                      setHistIdx(-1);
                    }
              }
              onKeyPress={raw ? (e) => onRawKeyPress(e.nativeEvent.key) : undefined}
              onSubmitEditing={raw ? submitRaw : submitLine}
              blurOnSubmit={false}
              // Line mode wraps to at most three lines so a long command stays readable while it is
              // typed. Raw mode stays single-line: it forwards keystrokes as they happen, so there
              // is nothing to wrap and a growing box would only shrink the terminal.
              multiline={!raw}
              // Return still SENDS rather than inserting a newline, which is what `multiline`
              // does by default. Multi-line composition is a separate, unsettled question: the
              // tmux backend presses Enter between lines (`tmux/backend.ts`), so a multi-line body
              // would submit once per line inside a coding agent.
              submitBehavior={raw ? undefined : "submit"}
              onContentSizeChange={
                raw
                  ? undefined
                  : (e) => setInputHeight(clampInputHeight(e.nativeEvent.contentSize.height))
              }
              placeholder={raw ? "keys sent as you type" : "compose, then send"}
              placeholderTextColor={tokens.textFaint}
              autoCorrect={ime.autoCorrect}
              autoCapitalize={ime.autoCapitalize}
              spellCheck={ime.spellCheck}
              autoComplete={ime.autoComplete}
              textContentType="none"
              keyboardType={ime.keyboardType}
              // Keep terminal and key guide visible in Android landscape; Samsung's
              // fullscreen extract editor otherwise replaces the entire app.
              disableFullscreenUI
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
            {raw ? null : (
              <Pressable
                accessibilityLabel="Previous command"
                onPress={browseHistory}
                style={{ padding: 8 }}
              >
                <Text style={{ color: tokens.textMuted }}>↑</Text>
              </Pressable>
            )}
          </View>
          {raw ? null : (
            <Pressable
              accessibilityLabel="Send"
              disabled={!connected}
              accessibilityState={{ disabled: !connected }}
              onPress={submitLine}
              style={{
                width: 40,
                height: 40,
                borderRadius: tokens.radius.md,
                backgroundColor: connected && text.trim() ? accent : tokens.surface2,
                alignItems: "center",
                justifyContent: "center",
              }}
            >
              <Text
                style={{
                  color: connected && text.trim() ? tokens.bg : tokens.textFaint,
                  fontWeight: "700",
                }}
              >
                ↩
              </Text>
            </Pressable>
          )}
        </View>
      </Bar>
      <Modal
        visible={keysOpen}
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
                  style={{ padding: 12 }}
                >
                  <Text style={{ color: accent, fontSize: 16 }}>Done</Text>
                </Pressable>
              </View>
              <Text style={{ color: tokens.textMuted, fontSize: 15 }}>
                Keys and replies are sent to this terminal. Your unsent draft stays in the input
                field.
              </Text>
              <Text style={{ color: tokens.text, fontSize: 15 }}>{presentation.hostLabel}</Text>
              <Text style={{ color: tokens.textMuted, fontSize: 15 }}>{presentation.guide}</Text>
              {showChips ? <ReplyChips onLine={sendLine} onKey={sendKey} /> : null}
              <QuickKeys
                disabled={!connected}
                hostPlatform={hostPlatform}
                onKey={sendKey}
                onPaste={() => void paste()}
              />
              <Pressable
                accessibilityRole="button"
                accessibilityLabel={raw ? "Switch to line mode" : "Switch to raw mode"}
                onPress={() => setRaw(sessionId, !raw)}
                style={{
                  padding: 12,
                  borderWidth: 1,
                  borderColor: tokens.border,
                  borderRadius: tokens.radius.md,
                }}
              >
                <Text style={{ color: tokens.text, fontSize: 15 }}>
                  {raw ? "Switch to line mode" : "Switch to raw mode"}
                </Text>
              </Pressable>
              <Text style={{ color: tokens.textMuted, fontSize: 15 }}>
                {raw
                  ? "Raw mode sends keys as you type."
                  : "Line mode lets you compose before sending."}
              </Text>
            </ScrollView>
          </KeyGuideSafeArea>
        </SafeAreaProvider>
      </Modal>
    </>
  );
}
