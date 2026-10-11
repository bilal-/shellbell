import type { NamedKey } from "@shellbell/protocol";
import * as Clipboard from "expo-clipboard";
import * as Haptics from "expo-haptics";
import { type ReactNode, useEffect, useRef, useState } from "react";
import { Keyboard, Modal, Pressable, ScrollView, Text, TextInput, View } from "react-native";
import { SafeAreaProvider, useSafeAreaInsets } from "react-native-safe-area-context";
import { connectionManager } from "../net/manager";
import { useCloseWhenHidden } from "../security/screen-hidden";
import { pendingInputHooks, useConnectionsStore } from "../store/connections";
import type { TerminalControls } from "../terminal/controls";
import { tokens } from "../theme/tokens";
import { AppIcon } from "../ui/AppIcon";
import { Bar } from "../ui/Bar";
import { agentName, agentPlaceholder, type BlockedPrompt } from "./agentPrompt";
import { type ComposedInputResult, fireInput, INPUT_DELIVERY_UNKNOWN } from "./fireInput";
import { clampInputHeight, INPUT_MIN_HEIGHT } from "./height";
import { COMPOSER_IME, SECRET_IME } from "./imeProps";
import { keyPresentation } from "./keyPresentation";
import { LiveKeysField } from "./LiveKeysField";
import { composerLayout, REPLY_CHIP_HEIGHT } from "./layout";
import { inputTextExceedsLimit, lineExceedsLimit } from "./limits";
import { TerminalBatcher } from "./liveKeys";
import { QuickKeys } from "./QuickKeys";
import { ReplyChips } from "./ReplyChips";
import { type WaitingReply, WaitingStrip } from "./WaitingStrip";

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

type InputMode = "command" | "live" | "secret";

/** Screen readers reach Send's long press (previous commands) as a named action. */
const HISTORY_ACTIONS = [{ name: "longpress", label: "Previous command" }];

/**
 * The phone's text path into a terminal: a native command bar that sends whole lines, above it a
 * row of terminal keys that send at once. Live keys swaps the command bar for a field whose every
 * keystroke goes to the terminal, for full-screen programs. A physical keyboard bypasses all of
 * this and types into xterm directly.
 */
export function InputBar({
  fp,
  sessionId,
  accent,
  showChips,
  availableHeight = null,
  terminalControls,
  hardwareKeyboard = false,
  onSubmitLine,
  onTerminalInput,
  alternateScreen,
  secretPrompt = false,
  agent,
  sessionState,
  prompt,
}: {
  fp: string;
  sessionId: string;
  accent: string;
  showChips: boolean;
  availableHeight?: number | null;
  terminalControls?: TerminalControls;
  hardwareKeyboard?: boolean;
  onSubmitLine?: (line: string, reqId: string) => Promise<ComposedInputResult>;
  /** Exact terminal bytes, without the xterm round trip. */
  onTerminalInput?: (data: string) => boolean;
  /** The host's report that a full-screen program is running; `undefined` when unknown. */
  alternateScreen?: boolean;
  /** The cursor row ends with a password prompt, so offer Secret input. */
  secretPrompt?: boolean;
  /** A coding agent (Claude Code, Codex) runs in the session: the bar talks to it. */
  agent?: { kind: string };
  /** The session's reported state; `blocked` means it waits on the person. */
  sessionState?: string;
  /** What a blocked session asks, read from its screen. */
  prompt?: BlockedPrompt;
}) {
  const connected = useConnectionsStore(
    (s) => s.byComputer[fp]?.status === "online" && s.byComputer[fp]?.transport?.ready !== false,
  );
  const hostPlatform = useConnectionsStore((s) => s.byComputer[fp]?.hello?.hostPlatform);
  const presentation = keyPresentation(hostPlatform);
  const [submitting, setSubmitting] = useState(false);
  const submission = useRef(false);
  const mounted = useRef(true);
  const retry = useRef<{ line: string; reqId: string } | null>(null);
  const [text, setText] = useState("");
  const [histIdx, setHistIdx] = useState(-1);
  const [inputHeight, setInputHeight] = useState(INPUT_MIN_HEIGHT);
  const [keysOpen, setKeysOpen] = useState(false);
  const hidden = useCloseWhenHidden(keysOpen, () => setKeysOpen(false));
  // Live keys need exact terminal input, which `terminalControls` stands for.
  const liveAvailable = Boolean(terminalControls);
  const [chosenMode, setMode] = useState<InputMode>(() =>
    alternateScreen === true && liveAvailable ? "live" : "command",
  );
  const mode: InputMode = chosenMode === "live" && !liveAvailable ? "command" : chosenMode;
  /** Whether the next field to mount takes focus, keeping the keyboard up across a mode change. */
  const focusNext = useRef(false);
  const fieldFocused = useRef(false);
  const seenAlternate = useRef(liveAvailable ? alternateScreen : undefined);
  const [secret, setSecret] = useState("");
  /** The mode Secret input returns to once the password is sent or dismissed. */
  const beforeSecret = useRef<InputMode>("command");
  const accessories = !hardwareKeyboard;
  const offerSecret = secretPrompt && mode !== "secret";
  // A reply dismisses the waiting strip until the session's state changes again.
  const [stripDismissed, setStripDismissed] = useState(false);
  const seenState = useRef(sessionState);
  if (seenState.current !== sessionState) {
    seenState.current = sessionState;
    if (stripDismissed) setStripDismissed(false);
  }
  const waiting =
    sessionState === "blocked" && mode === "command" && accessories && !stripDismissed;
  // An agent's keys row already leads with Esc and Enter, and a blocked agent gets the waiting
  // strip; generic y/n chips would only repeat them.
  const replyChips = showChips && !agent;
  const layout = composerLayout(
    availableHeight,
    inputHeight,
    replyChips || offerSecret || waiting,
    accessories,
  );
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
  // A full-screen program starting or ending picks the mode; a manual choice holds until the next
  // change. An unknown report (an older computer) changes nothing.
  useEffect(() => {
    // A report that arrives while Reading hides the terminal is applied when it returns.
    if (!liveAvailable) return;
    if (alternateScreen === undefined || alternateScreen === seenAlternate.current) return;
    seenAlternate.current = alternateScreen;
    focusNext.current = fieldFocused.current;
    // Never take a half-typed password field away.
    setMode((current) => (current === "secret" ? current : alternateScreen ? "live" : "command"));
  }, [alternateScreen, liveAvailable]);
  // The bar renders nothing while a physical keyboard is attached, so the native field is gone
  // before xterm takes focus; an unsent draft stays in state for detachment.
  useEffect(() => {
    if (!hardwareKeyboard) return;
    setKeysOpen(false);
    terminalControls?.command({ type: "focus" });
  }, [hardwareKeyboard, terminalControls]);

  /** Live keystrokes, batched; everything else flushes them first so the host sees key order. */
  const sendLive = (data: string) => {
    if (!connected) return false;
    return onTerminalInput
      ? onTerminalInput(data)
      : (terminalControls?.command({ type: "input", data }) ?? false);
  };
  const batcher = useRef<TerminalBatcher | null>(null);
  batcher.current ??= new TerminalBatcher(sendLive);
  batcher.current.setSender(sendLive);
  const flushLive = () => batcher.current?.flush();
  useEffect(() => () => batcher.current?.flush(), []);

  const fire = (msg: Req): Promise<unknown> | null => {
    flushLive();
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
  /** Raw terminal bytes: a modifier chord, a reply key, or a draft completed with Tab. */
  const sendText = (data: string) => {
    flushLive();
    if (!connected || !data) return false;
    if (terminalControls) {
      if (!onTerminalInput) return terminalControls.command({ type: "input", data });
      void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
      return onTerminalInput(data);
    }
    const c = conn();
    return Boolean(c && fire({ type: "input.text", reqId: c.newReqId(), sessionId, text: data }));
  };
  const sendLine = async (line: string, remember = true): Promise<boolean> => {
    if (!connected || submission.current) return false;
    flushLive();
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
      if (accepted && remember)
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
      flushLive();
      if (terminalControls) terminalControls.command({ type: "paste", text: value });
      else setText(value); // Older hosts: review, then explicitly send.
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
  const enterSecret = () => {
    if (mode === "secret") return;
    beforeSecret.current = mode;
    focusNext.current = true;
    setMode("secret");
  };
  const leaveSecret = () => {
    setSecret("");
    if (retry.current?.line === secret) retry.current = null;
    focusNext.current = true;
    setMode(beforeSecret.current);
  };
  /** A password is sent once with Return and never enters draft history. */
  const submitSecret = async () => {
    const line = secret;
    if (!line || !(await sendLine(line, false))) return;
    setSecret("");
    focusNext.current = fieldFocused.current;
    setMode(beforeSecret.current);
  };
  const submit = async () => {
    const line = text;
    if (!line.trim() || !(await sendLine(line))) return;
    setText((current) => (current === line ? "" : current));
    setHistIdx(-1);
    setInputHeight(INPUT_MIN_HEIGHT);
  };
  /**
   * Tab completes what the draft started: the draft is typed into the shell's own line (no
   * Return) followed by Tab, in one message, and the field clears for the rest of the command.
   * A multi-line draft would run its first lines, so Tab is then just Tab.
   */
  const pressKey = (key: NamedKey) => {
    if (mode === "command" && key === "tab" && text.trim() && !/[\r\n]/.test(text)) {
      if (!sendText(`${text}\t`)) return false;
      setText("");
      setHistIdx(-1);
      setInputHeight(INPUT_MIN_HEIGHT);
      return true;
    }
    return sendKey(key);
  };
  const keys = (guide = false) => (
    <QuickKeys
      key={`${guide ? "guide" : "bar"}:${fp}:${sessionId}`}
      disabled={!connected}
      hostPlatform={hostPlatform}
      agent={Boolean(agent)}
      keyHeight={guide ? undefined : layout.keyHeight}
      onKey={guide ? sendKey : pressKey}
      onText={sendText}
      onPaste={() => void paste()}
      onGuide={guide ? undefined : openKeys}
      secret={guide ? undefined : { active: mode === "secret", onToggle: secretToggle }}
    />
  );
  /**
   * Live keys belong to full-screen programs. An agent session offers them only while the computer
   * reports one (an agent's own screen is better served by the command bar), and never hides the
   * switch while Live keys are on.
   */
  const liveOffered = liveAvailable && (!agent || alternateScreen === true || mode === "live");
  const liveToggle = () => (
    <Pressable
      accessibilityRole="switch"
      accessibilityLabel="Live keys"
      accessibilityHint="Sends each key straight to the terminal, for vim, less and other full-screen programs"
      accessibilityState={{ checked: mode === "live", disabled: !connected }}
      disabled={!connected}
      onPress={() => {
        focusNext.current = true;
        setMode(mode === "live" ? "command" : "live");
      }}
      hitSlop={4}
      style={{ minHeight: 44, minWidth: 40, alignItems: "center", justifyContent: "center" }}
    >
      <View
        style={{
          width: 32,
          height: 32,
          borderRadius: 16,
          alignItems: "center",
          justifyContent: "center",
          backgroundColor: mode === "live" ? accent : "transparent",
          opacity: connected ? 1 : 0.4,
        }}
      >
        <AppIcon name="keyboard" size={18} color={mode === "live" ? tokens.bg : tokens.textMuted} />
      </View>
    </Pressable>
  );
  const reply = (choice: WaitingReply) => {
    const sent = "text" in choice ? sendText(choice.text) : sendKey(choice.key);
    if (sent) setStripDismissed(true);
  };
  function secretToggle() {
    if (mode === "secret") leaveSecret();
    else enterSecret();
  }
  /** With nothing drafted, Send becomes the terminal's Enter key, to confirm or continue. */
  const drafted = Boolean(text.trim());
  const sendable = connected && drafted && !submitting;
  const onHistoryAction = (event: { nativeEvent: { actionName: string } }) => {
    if (event.nativeEvent.actionName === "longpress") browseHistory();
  };
  const secretSendable = connected && secret.length > 0 && !submitting;

  // Hide every keyboard accessory, including an already-open guide, on physical attachment.
  if (hardwareKeyboard && terminalControls) return null;
  return (
    <>
      <Bar style={{ gap: 4 }} verticalPadding={layout.verticalPadding}>
        {waiting ? (
          <WaitingStrip
            label={
              agent && agentName(agent.kind)
                ? `${agentName(agent.kind)} is waiting`
                : "Waiting for you"
            }
            question={prompt?.question ?? null}
            options={prompt?.options ?? null}
            accent={accent}
            enterLabel={presentation.enterLabel}
            compact={layout.compact}
            chipHeight={layout.compact ? layout.keyHeight : undefined}
            disabled={!connected}
            onReply={reply}
          />
        ) : accessories ? (
          keys()
        ) : null}
        {offerSecret && !layout.compact ? (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Type password securely"
            accessibilityHint="Opens a hidden field that is not saved to command history"
            disabled={!connected}
            accessibilityState={{ disabled: !connected }}
            onPress={enterSecret}
            style={{
              minHeight: REPLY_CHIP_HEIGHT,
              flexDirection: "row",
              gap: 8,
              borderRadius: tokens.radius.sm,
              borderWidth: 1,
              borderColor: tokens.border,
              backgroundColor: tokens.surface,
              alignItems: "center",
              justifyContent: "center",
              opacity: connected ? 1 : 0.4,
            }}
          >
            <AppIcon name="lock" size={16} color={tokens.textMuted} />
            <Text style={{ color: tokens.text, fontSize: 13, fontWeight: "600" }}>
              Password prompt · type it securely
            </Text>
          </Pressable>
        ) : replyChips && !layout.compact && accessories && !waiting ? (
          <ReplyChips
            onText={sendText}
            onKey={sendKey}
            enterLabel={presentation.enterLabel}
            disabled={!connected || submitting}
          />
        ) : null}
        {mode === "secret" ? (
          <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
            <View
              style={{
                flex: 1,
                flexDirection: "row",
                alignItems: "center",
                backgroundColor: tokens.surface2,
                borderRadius: 16,
                borderWidth: 1,
                borderColor: tokens.border,
                paddingLeft: 12,
              }}
            >
              <AppIcon name="lock" size={16} color={tokens.textMuted} />
              <TextInput
                accessibilityLabel="Secret input"
                accessibilityHint="Hidden, sent once with Enter, and never saved"
                autoFocus={focusNext.current}
                onFocus={() => {
                  fieldFocused.current = true;
                }}
                onBlur={() => {
                  fieldFocused.current = false;
                }}
                value={secret}
                editable={!submitting}
                onChangeText={setSecret}
                onSubmitEditing={submitSecret}
                blurOnSubmit={false}
                submitBehavior="submit"
                secureTextEntry
                disableFullscreenUI
                placeholder="Password, never saved"
                placeholderTextColor={tokens.textFaint}
                autoCorrect={SECRET_IME.autoCorrect}
                autoCapitalize={SECRET_IME.autoCapitalize}
                spellCheck={SECRET_IME.spellCheck}
                autoComplete={SECRET_IME.autoComplete}
                textContentType="none"
                importantForAutofill="no"
                keyboardType={SECRET_IME.keyboardType}
                returnKeyType="send"
                style={{
                  flex: 1,
                  color: tokens.text,
                  paddingVertical: 10,
                  paddingHorizontal: 8,
                  fontSize: 15,
                  height: Math.min(layout.inputHeight, INPUT_MIN_HEIGHT),
                }}
              />
              <Pressable
                accessibilityRole="button"
                accessibilityLabel="Cancel secret input"
                onPress={leaveSecret}
                style={{ padding: 12, minHeight: 44 }}
              >
                <AppIcon name="close" size={16} color={tokens.textMuted} />
              </Pressable>
            </View>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Send secret"
              disabled={!secretSendable}
              accessibilityState={{ disabled: !secretSendable }}
              onPress={submitSecret}
              style={{
                width: 44,
                height: 44,
                borderRadius: tokens.radius.md,
                backgroundColor: connected && secret ? accent : tokens.surface2,
                alignItems: "center",
                justifyContent: "center",
              }}
            >
              <AppIcon name="return" color={connected && secret ? tokens.bg : tokens.textFaint} />
            </Pressable>
          </View>
        ) : mode === "live" ? (
          <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
            <View
              style={{
                flex: 1,
                flexDirection: "row",
                alignItems: "center",
                backgroundColor: tokens.surface2,
                borderRadius: 16,
                borderWidth: 1,
                borderColor: tokens.accents.emerald,
                paddingLeft: 14,
              }}
            >
              <View
                accessible={false}
                importantForAccessibility="no"
                style={{
                  width: 8,
                  height: 8,
                  borderRadius: 4,
                  backgroundColor: tokens.accents.emerald,
                }}
              />
              <LiveKeysField
                onBytes={(data) => batcher.current?.push(data)}
                autoFocus={focusNext.current}
                editable={connected}
                height={Math.min(layout.inputHeight, INPUT_MIN_HEIGHT)}
                onFocusChange={(focused) => {
                  fieldFocused.current = focused;
                }}
              />
              {liveOffered ? <View style={{ paddingRight: 4 }}>{liveToggle()}</View> : null}
            </View>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={`Send ${presentation.enterLabel}`}
              disabled={!connected}
              accessibilityState={{ disabled: !connected }}
              onPress={() => sendKey("enter")}
              style={{
                width: 44,
                height: 44,
                borderRadius: tokens.radius.md,
                backgroundColor: connected ? accent : tokens.surface2,
                alignItems: "center",
                justifyContent: "center",
              }}
            >
              <AppIcon name="return" color={connected ? tokens.bg : tokens.textFaint} />
            </Pressable>
          </View>
        ) : (
          <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
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
              {agent ? (
                <View
                  accessible={false}
                  importantForAccessibility="no"
                  style={{ height: INPUT_MIN_HEIGHT, justifyContent: "center" }}
                >
                  <AppIcon name="agent" size={16} color={tokens.textMuted} />
                </View>
              ) : (
                <Text
                  style={{
                    color: tokens.textMuted,
                    fontWeight: "700",
                    lineHeight: INPUT_MIN_HEIGHT,
                  }}
                >
                  $
                </Text>
              )}
              <TextInput
                accessibilityLabel="Command draft"
                autoFocus={focusNext.current}
                onFocus={() => {
                  fieldFocused.current = true;
                }}
                onBlur={() => {
                  fieldFocused.current = false;
                }}
                value={text}
                editable={!submitting}
                onChangeText={(value) => {
                  setText(value);
                  setHistIdx(-1);
                }}
                // An agent takes a message: Return starts a new line and Send sends all of it.
                // A shell takes a command, so Return sends it.
                onSubmitEditing={agent ? undefined : submit}
                blurOnSubmit={false}
                multiline
                submitBehavior={agent ? "newline" : "submit"}
                disableFullscreenUI
                onContentSizeChange={(event) =>
                  setInputHeight(clampInputHeight(event.nativeEvent.contentSize.height))
                }
                placeholder={agent ? agentPlaceholder(agent.kind) : "Type a command"}
                placeholderTextColor={tokens.textFaint}
                autoCorrect={ime.autoCorrect}
                autoCapitalize={ime.autoCapitalize}
                spellCheck={ime.spellCheck}
                autoComplete={ime.autoComplete}
                textContentType="none"
                keyboardType={ime.keyboardType}
                returnKeyType={agent ? "default" : "send"}
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
                accessibilityHint="Fills the field from commands sent from this phone"
                onPress={browseHistory}
                style={{ padding: 12, minHeight: 44 }}
              >
                <AppIcon name="history" color={tokens.textMuted} />
              </Pressable>
              {liveOffered ? (
                <View style={{ paddingRight: 4, marginLeft: -8 }}>{liveToggle()}</View>
              ) : null}
            </View>
            {drafted ? (
              <Pressable
                accessibilityRole="button"
                accessibilityLabel="Send"
                accessibilityHint="Long press for previous commands"
                accessibilityActions={HISTORY_ACTIONS}
                onAccessibilityAction={onHistoryAction}
                disabled={!sendable}
                accessibilityState={{ disabled: !sendable }}
                onPress={submit}
                onLongPress={browseHistory}
                style={{
                  width: 44,
                  height: 44,
                  borderRadius: tokens.radius.md,
                  backgroundColor: connected ? accent : tokens.surface2,
                  alignItems: "center",
                  justifyContent: "center",
                }}
              >
                <AppIcon name="return" color={connected ? tokens.bg : tokens.textFaint} />
              </Pressable>
            ) : (
              <Pressable
                accessibilityRole="button"
                accessibilityLabel="Enter"
                accessibilityHint="Sends Enter to the terminal. Long press for previous commands"
                accessibilityActions={HISTORY_ACTIONS}
                onAccessibilityAction={onHistoryAction}
                disabled={!connected}
                accessibilityState={{ disabled: !connected }}
                onPress={() => sendKey("enter")}
                onLongPress={browseHistory}
                style={{
                  width: 44,
                  height: 44,
                  borderRadius: tokens.radius.md,
                  borderWidth: 1.5,
                  borderColor: connected ? accent : tokens.border,
                  backgroundColor: "transparent",
                  alignItems: "center",
                  justifyContent: "center",
                }}
              >
                <AppIcon name="return" color={connected ? accent : tokens.textFaint} />
              </Pressable>
            )}
          </View>
        )}
      </Bar>
      <Modal
        visible={keysOpen && !hardwareKeyboard && !hidden}
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
              <Text style={{ color: tokens.textMuted, fontSize: 15 }}>
                Type in the command bar and press Send to run a line. Tab sends what you typed so
                far and then Tab, so the shell can complete it.
              </Text>
              {agent ? (
                <Text style={{ color: tokens.textMuted, fontSize: 15 }}>
                  With a coding agent the row starts with its keys: Esc interrupts, the arrows and
                  Enter move through its menus, ⇧Tab switches its mode and 1, 2 and 3 pick a
                  numbered choice. Esc and ^C are tinted because they stop what is running.
                </Text>
              ) : null}
              <Text style={{ color: tokens.textMuted, fontSize: 15 }}>
                When the computer reports that a session is waiting for you, the keys give way to
                its question and large replies: one per numbered choice when the agent shows a menu
                Shellbell can read, which types that number, otherwise Yes, No, Enter and Esc. After
                a reply the keys come back until the session waits again.
              </Text>
              <Text style={{ color: tokens.textMuted, fontSize: 15 }}>
                Live keys send each key as you type it, for vim, less, top and other full-screen
                programs. They turn on by themselves when the computer reports one, if it can, and
                off when the program ends. Tap the keyboard button in the field to switch yourself;
                your choice holds until the program changes. With a coding agent the button only
                appears while a full-screen program is running.
              </Text>
              <Text style={{ color: tokens.textMuted, fontSize: 15 }}>
                Secret hides what you type for passwords and passphrases. It is sent once with Enter
                and never saved to command history. Shellbell offers it when the terminal asks for a
                password.
              </Text>
              <Text style={{ color: tokens.text, fontSize: 15 }}>{presentation.hostLabel}</Text>
              <Text style={{ color: tokens.textMuted, fontSize: 15 }}>{presentation.guide}</Text>
              {replyChips ? (
                <ReplyChips
                  onText={sendText}
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
