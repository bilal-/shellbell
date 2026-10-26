import { CONVERSATION_FEATURE, type TerminalMouseClick } from "@shellbell/protocol";
import { useKeepAwake } from "expo-keep-awake";
import { Stack, useFocusEffect, useLocalSearchParams, useRouter } from "expo-router";
import { useHeaderHeight } from "expo-router/react-navigation";
import { useCallback, useEffect, useRef, useState } from "react";
import { BackHandler, Pressable, Text, View } from "react-native";
import {
  KeyboardAvoidingView,
  KeyboardController,
  useKeyboardState,
} from "react-native-keyboard-controller";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { prefersConversation } from "../../../../src/agents/registry";
import {
  CODEX_INTEGRATION_HINT,
  ConversationView,
  conversationUnavailable,
} from "../../../../src/conversation/ConversationView";
import {
  type ComposedInputResult,
  fireInput,
  INPUT_DELIVERY_UNKNOWN,
} from "../../../../src/input/fireInput";
import { InputBar } from "../../../../src/input/InputBar";
import { inputTextExceedsLimit } from "../../../../src/input/limits";
import { terminalInputFacts } from "../../../../src/input/terminalFacts";
import { useHardwareKeyboard } from "../../../../src/input/useHardwareKeyboard";
import { useScreenReader } from "../../../../src/input/useScreenReader";
import { connectionManager, type FocusedViewLease } from "../../../../src/net/manager";
import type { MobileConversationSnapshot } from "../../../../src/net/mobile-conversation";
import { dismissComputerNotifications } from "../../../../src/notifications";
import { ScreenView } from "../../../../src/screen/ScreenView";
import { useComputersStore } from "../../../../src/store/computers";
import { pendingInputHooks, useConnectionsStore } from "../../../../src/store/connections";
import { useNetworkStore } from "../../../../src/store/network";
import { TerminalControls } from "../../../../src/terminal/controls";
import type { VtSource } from "../../../../src/terminal/vt-bridge";
import type { VtStatus } from "../../../../src/terminal/XtermView";
import { tokens } from "../../../../src/theme/tokens";
import { EmptyState } from "../../../../src/ui/EmptyState";
import { HeaderButton } from "../../../../src/ui/HeaderButton";
import { SessionHeaderTitle } from "../../../../src/ui/SessionHeaderTitle";
import { SessionMenuButton } from "../../../../src/ui/SessionMenuButton";
import { StatusOverlay } from "../../../../src/ui/StatusOverlay";
import { TransportStatus } from "../../../../src/ui/TransportStatus";
import { activeBackends, backendLabel, cursorIsInferred } from "../../../../src/util/backends";
import { connectionNotice } from "../../../../src/util/connection-state";
import { sidFromRoute } from "../../../../src/util/routes";
import { sessionStatusLine, sessionTitle } from "../../../../src/util/session-label";
import { cursorBlinks, sessionEnded, wantsReply } from "../../../../src/util/session-state";

/** How long a Claude or Codex session waits for its conversation before showing the terminal. */
const CONVERSATION_OPENING_MS = 8000;
/** Shown before the computer's first conversation message arrives. */
const OPENING_SNAPSHOT: Readonly<MobileConversationSnapshot> = Object.freeze({
  state: "checking",
  entries: [],
  history: "unloaded",
  historyStatus: "idle",
  canRequestOlder: false,
  caughtUp: null,
  notice: null,
  reason: null,
});

export default function Session() {
  const keyboardVisible = useKeyboardState((state) => state.isVisible);
  const hardwareKeyboard = useHardwareKeyboard();
  const screenReader = useScreenReader();
  const terminalControls = useRef(new TerminalControls()).current;
  const network = useNetworkStore((s) => s.snapshot);
  const insets = useSafeAreaInsets();
  const headerHeight = useHeaderHeight();
  const [availableHeight, setAvailableHeight] = useState<number | null>(null);
  useKeepAwake();
  const { fp, sid } = useLocalSearchParams<{ fp: string; sid: string }>();
  const router = useRouter();
  const sessionId = sidFromRoute(sid ?? "");
  const readingKey = JSON.stringify([fp, sessionId]);
  const [readingContext, setReadingContext] = useState({ key: readingKey, enabled: false });
  const readingMode = readingContext.key === readingKey && readingContext.enabled;
  // `null` until the owner picks a view; then their choice wins over the agent's default.
  const [conversationContext, setConversationContext] = useState<{
    key: string;
    wanted: boolean | null;
  }>({ key: readingKey, wanted: null });
  const [defaultView, setDefaultView] = useState<{ key: string; conversation: boolean } | null>(
    null,
  );
  /** Whether the focus effect's claim should ask for raw output; set once mouse mode is known. */
  const rawWantedRef = useRef(!readingMode);
  const [mouseContext, setMouseContext] = useState({ key: readingKey, enabled: false });
  /** The view whose conversation took too long to open, so it shows the terminal instead. */
  const [openingExpired, setOpeningExpired] = useState<string | null>(null);
  const mousePending = useRef<symbol | null>(null);
  // Search and selection are opened from the session menu or a long press, not a toolbar.
  const [searchOpen, setSearchOpen] = useState(false);
  const [selecting, setSelecting] = useState(false);
  const [hasSelection, setHasSelection] = useState(false);
  useEffect(() => {
    setReadingContext({ key: readingKey, enabled: false });
    setConversationContext({ key: readingKey, wanted: null });
    setDefaultView(null);
    setMouseContext({ key: readingKey, enabled: false });
    setSearchOpen(false);
    setSelecting(false);
    setHasSelection(false);
    mousePending.current = null;
  }, [readingKey]);
  const terminalSelecting = selecting && !readingMode;
  useEffect(() => {
    if (!terminalSelecting) return;
    // Android's Back leaves selection first, as it does for any text action mode.
    const subscription = BackHandler.addEventListener("hardwareBackPress", () => {
      setSelecting(false);
      return true;
    });
    return () => subscription.remove();
  }, [terminalSelecting]);
  const computer = useComputersStore((s) => s.computers.find((c) => c.fp === fp));
  const conn = useConnectionsStore((s) => s.byComputer[fp ?? ""]);
  const session = conn?.sessions.find((s) => s.id === sessionId);
  const chosenView = conversationContext.key === readingKey ? conversationContext.wanted : null;
  // The agent's default is decided once per view, when its kind is first known. A late kind
  // switches the view once; an agent that quits or is renamed doesn't flip it back.
  const agentKind = session?.agent?.kind;
  useEffect(() => {
    if (agentKind && defaultView?.key !== readingKey)
      setDefaultView({ key: readingKey, conversation: prefersConversation(agentKind) });
  }, [agentKind, defaultView, readingKey]);
  // Until the latch is stored, the agent known now decides, so the first render is right.
  const conversationWanted =
    chosenView ??
    (defaultView?.key === readingKey
      ? defaultView.conversation
      : agentKind
        ? prefersConversation(agentKind)
        : false);
  const conversationWantedRef = useRef(conversationWanted);
  conversationWantedRef.current = conversationWanted;
  const mouseSupported =
    activeBackends(conn?.hello).find((backend) => backend.name === session?.backend)?.capabilities
      .mouseClick === true;
  const inputReady = conn?.status === "online" && conn.transport?.ready !== false;
  const terminalSupported =
    activeBackends(conn?.hello).find((backend) => backend.name === session?.backend)?.capabilities
      .terminalInput === true;
  const pasteSupported =
    activeBackends(conn?.hello).find((backend) => backend.name === session?.backend)?.capabilities
      .terminalPaste === true;
  const fireTerminalInput = (data: string, paste = false, submit = false, requestId?: string) => {
    const c = connectionManager.get(fp ?? "");
    if (!inputReady || !terminalSupported || !c?.online || !data) return null;
    const reqId = requestId ?? c.newReqId();
    const message = paste
      ? { type: "input.paste" as const, reqId, sessionId, text: data, submit }
      : {
          type: "input.terminal" as const,
          reqId,
          sessionId,
          data: data + (submit ? "\r" : ""),
        };
    if (inputTextExceedsLimit(message)) return null;
    return fireInput(c, message, pendingInputHooks(fp ?? "", sessionId));
  };
  const sendTerminalInput = (data: string, paste = false, submit = false) =>
    Boolean(fireTerminalInput(data, paste, submit));
  const submitTerminalLine = async (text: string, reqId: string): Promise<ComposedInputResult> => {
    const outcome = await fireTerminalInput(
      text.replace(/\r?\n/g, "\r"),
      pasteSupported,
      true,
      reqId,
    );
    if (outcome === INPUT_DELIVERY_UNKNOWN) return outcome;
    return (
      typeof outcome === "object" && outcome !== null && "ok" in outcome && outcome.ok === true
    );
  };
  const mouseMode =
    mouseSupported &&
    inputReady &&
    !readingMode &&
    mouseContext.key === readingKey &&
    mouseContext.enabled;
  useEffect(() => {
    if (!inputReady || !mouseSupported) setMouseContext({ key: readingKey, enabled: false });
  }, [inputReady, mouseSupported, readingKey]);
  const sendMouse = (click: TerminalMouseClick) => {
    const c = connectionManager.get(fp ?? "");
    if (!mouseMode || !c?.online || mousePending.current) return;
    const token = Symbol("mouse input");
    mousePending.current = token;
    const reqId = c.newReqId();
    void fireInput(
      c,
      { type: "input.mouse", reqId, sessionId, ...click },
      pendingInputHooks(fp ?? "", sessionId),
    ).finally(() => {
      if (mousePending.current === token) mousePending.current = null;
    });
  };
  const accentKey = (computer?.accent ?? "emerald") as keyof typeof tokens.accents;
  const accent = tokens.accents[accentKey] ?? tokens.accents.emerald;
  const lease = useRef<FocusedViewLease | null>(null);

  useFocusEffect(
    useCallback(() => {
      const claimed = connectionManager.claimView(fp ?? "", sessionId, {
        conversation: conversationWantedRef.current,
      });
      claimed.setRawStream(rawWantedRef.current);
      lease.current = claimed;
      useConnectionsStore.getState().patch(fp ?? "", (x) => ({
        unread: { ...x.unread, [sessionId]: 0 },
      }));
      // Spec §6: if you are looking at it, it is not waiting for you. A failure here must never
      // break the screen — a stale notification is a nuisance, a crashed render is a bug.
      if (fp) void dismissComputerNotifications(fp, sessionId).catch(() => undefined);
      return () => {
        if (lease.current === claimed) lease.current = null;
        claimed.release();
        // The composer or terminal may still hold the keyboard; leaving it open behind a popped
        // screen leaves the rest of the app sized for a keyboard that is no longer there.
        void KeyboardController.dismiss();
      };
    }, [fp, sessionId]),
  );

  const stream = conn?.boundedView?.sessionId === sessionId ? conn.boundedView.snapshot : undefined;
  const conversation =
    conn?.conversationView?.sessionId === sessionId ? conn.conversationView : undefined;
  const conversationShown =
    conversationWanted &&
    !selecting &&
    !searchOpen &&
    !readingMode &&
    !mouseMode &&
    conn?.hello?.conversationEnabled === true &&
    conn.hello.features?.includes(CONVERSATION_FEATURE) === true;
  // While the computer works out which conversation this is, open straight into Conversation
  // instead of flashing the terminal first. If that takes too long, show the terminal.
  const opening =
    conversationShown &&
    (!conversation || conversation.snapshot.state === "checking") &&
    openingExpired !== readingKey;
  useEffect(() => {
    if (!opening) return;
    const timer = setTimeout(() => setOpeningExpired(readingKey), CONVERSATION_OPENING_MS);
    return () => clearTimeout(timer);
  }, [opening, readingKey]);
  // A conversation that opened gives the next check, say after a reconnect, a fresh wait.
  const conversationReady = conversation?.snapshot.state === "ready";
  useEffect(() => {
    if (conversationReady) setOpeningExpired(null);
  }, [conversationReady]);
  const showConversation = conversationShown && (conversationReady || opening);
  useEffect(() => {
    if (showConversation) terminalControls.command({ type: "blur" });
  }, [showConversation, terminalControls]);
  useEffect(() => {
    lease.current?.setConversation(conversationWanted);
  }, [conversationWanted]);
  // Raw streams: the terminal itself says whether a full-screen program runs and what the
  // cursor row reads; snapshots carry both in the session list and the screen.
  const [vtContext, setVtContext] = useState<{ log: VtSource; status: VtStatus } | null>(null);
  const vtStatus = stream?.vt?.log === vtContext?.log ? (vtContext?.status ?? null) : null;
  const raw = stream?.vt !== undefined;
  useEffect(() => {
    if (!raw) setVtContext(null);
  }, [raw]);
  // Reading view lays out snapshot rows, and mouse clicks are checked against them, so either
  // asks the computer for snapshots while it is on.
  const rawWanted = !readingMode && !mouseMode;
  rawWantedRef.current = rawWanted;
  useEffect(() => {
    lease.current?.setRawStream(rawWanted);
  }, [rawWanted]);
  const fallbackScreen =
    conn?.boundedView?.sessionId === sessionId ? conn.boundedView.fallbackScreen : undefined;
  const secretHint = useRef({ computer: fp, session: sessionId, value: false });
  if (secretHint.current.computer !== fp || secretHint.current.session !== sessionId)
    secretHint.current = { computer: fp, session: sessionId, value: false };
  const facts = terminalInputFacts(
    session?.backend ?? "",
    stream,
    vtStatus,
    stream?.screen ?? fallbackScreen,
    session?.alternateScreen,
    secretHint.current.value,
  );
  secretHint.current.value = facts.secret;
  const outputRetrying =
    conn?.boundedView?.sessionId === sessionId && conn.boundedView.retrying === true;
  const focusedLease = lease.current;
  const viewRevision = focusedLease?.revision() ?? null;
  const conversationRevision = focusedLease?.conversationRevision() ?? null;
  const loadOlderConversation = useCallback(() => {
    focusedLease?.requestOlderConversation(conversationRevision);
  }, [focusedLease, conversationRevision]);
  const loadOlder = useCallback(() => {
    focusedLease?.requestOlder(viewRevision);
  }, [focusedLease, viewRevision]);

  // The session left the computer's `sessions` list but a cached stream remains: it ended, and
  // the app must stop offering input for it (R59 ruling 1). The second disjunct only applies
  // while genuinely online (M7): otherwise a cold deep-link/notification tap into a session the
  // app has never fetched (`sessions` not loaded yet, or mid-reconnect) would render "Session
  // ended." for a session that may well still be running.
  const ended =
    sessionEnded(conn?.sessions ?? [], sessionId, stream) ||
    (conn?.status === "online" && !session && !stream);
  const backend = session ? backendLabel(session.backend, conn?.hello?.backendCatalog) : "";
  const name = session ? sessionTitle(session) : "Session";
  const sourceLabel = showConversation
    ? opening
      ? "Conversation"
      : conversation?.snapshot.caughtUp === false
        ? "Catching up"
        : "Conversation"
    : stream?.output
      ? { live: "Live", "catching-up": "Catching up", paused: "Paused", ended: "Ended" }[
          stream.output.state
        ]
      : undefined;
  const statusLine =
    [
      sourceLabel,
      conversationWanted && conversation && session?.agent
        ? (conversationUnavailable(conversation.snapshot, session.agent.kind) ??
          sessionStatusLine(session, backend))
        : session
          ? sessionStatusLine(session, backend)
          : undefined,
    ]
      .filter(Boolean)
      .join(" · ") || undefined;
  const dimmed = conn?.status !== "online" || conn.transport?.ready === false;
  const overlay = connectionNotice(conn, network, computer?.name);

  return (
    <KeyboardAvoidingView
      style={{ flex: 1 }}
      // Fabric can report an all-zero native frame during mount. Navigation's
      // measured header height stays valid and updates for rotation/safe areas.
      behavior="padding"
      keyboardVerticalOffset={headerHeight}
    >
      <View
        onLayout={({ nativeEvent: { layout } }) => {
          if (Number.isFinite(layout.height) && layout.height > 0)
            setAvailableHeight(layout.height);
        }}
        style={{
          flex: 1,
          backgroundColor: tokens.bg,
          paddingLeft: insets.left,
          paddingRight: insets.right,
        }}
      >
        <Stack.Screen
          options={
            terminalSelecting
              ? {
                  // A contextual bar, like Android's text action mode, replaces the header.
                  title: name,
                  headerBackVisible: false,
                  gestureEnabled: false,
                  headerLeft: () => (
                    <HeaderButton
                      icon="close"
                      label="Done selecting"
                      onPress={() => setSelecting(false)}
                    />
                  ),
                  headerTitle: () => (
                    <Text style={{ color: tokens.text, fontSize: 17, fontWeight: "600" }}>
                      Select text
                    </Text>
                  ),
                  headerRight: () => (
                    <View style={{ flexDirection: "row", alignItems: "center" }}>
                      <Pressable
                        accessibilityRole="button"
                        accessibilityLabel="Select all loaded terminal text"
                        onPress={() => terminalControls.command({ type: "select-all" })}
                        hitSlop={4}
                        style={({ pressed }) => ({
                          minHeight: 44,
                          paddingHorizontal: 10,
                          justifyContent: "center",
                          opacity: pressed ? 0.6 : 1,
                        })}
                      >
                        <Text style={{ color: tokens.text, fontSize: 15 }}>Select all</Text>
                      </Pressable>
                      <Pressable
                        accessibilityRole="button"
                        accessibilityLabel="Copy terminal selection"
                        onPress={() => terminalControls.command({ type: "copy", format: "text" })}
                        hitSlop={4}
                        style={({ pressed }) => ({
                          minHeight: 44,
                          paddingHorizontal: 10,
                          justifyContent: "center",
                          opacity: pressed ? 0.6 : 1,
                        })}
                      >
                        <Text
                          style={{
                            color: hasSelection ? accent : tokens.text,
                            fontSize: 15,
                            fontWeight: "600",
                          }}
                        >
                          Copy
                        </Text>
                      </Pressable>
                    </View>
                  ),
                }
              : {
                  title: name,
                  headerBackVisible: true,
                  gestureEnabled: true,
                  headerLeft: undefined,
                  headerTitle: () => (
                    <SessionHeaderTitle
                      fp={fp ?? ""}
                      title={name}
                      subtitle={
                        readingMode
                          ? [statusLine, "Reading"].filter(Boolean).join(" · ")
                          : statusLine
                      }
                    />
                  ),
                  headerBackTitle: session ? backend : undefined,
                  headerRight: () => (
                    <SessionMenuButton
                      fp={fp ?? ""}
                      sessionId={sessionId}
                      view={{
                        reading: readingMode,
                        conversation: conn?.hello?.features?.includes(CONVERSATION_FEATURE)
                          ? {
                              active: showConversation,
                              available: conn.hello.conversationEnabled === true && !ended,
                              onConversation: () => {
                                if (
                                  conversationWanted &&
                                  conversation?.snapshot.state === "unavailable"
                                )
                                  focusedLease?.refreshConversation(conversationRevision);
                                if (
                                  conversation?.snapshot.reason === "unbound" &&
                                  session?.agent?.kind === "codex"
                                )
                                  useConnectionsStore
                                    .getState()
                                    .patch(fp ?? "", () => ({ toast: CODEX_INTEGRATION_HINT }));
                                setReadingContext({ key: readingKey, enabled: false });
                                setMouseContext({ key: readingKey, enabled: false });
                                setSearchOpen(false);
                                setSelecting(false);
                                setOpeningExpired(null);
                                setConversationContext({ key: readingKey, wanted: true });
                              },
                              onTerminal: () =>
                                setConversationContext({ key: readingKey, wanted: false }),
                            }
                          : undefined,
                        onToggleReading: () => {
                          setConversationContext({ key: readingKey, wanted: false });
                          setMouseContext({ key: readingKey, enabled: false });
                          setSearchOpen(false);
                          setSelecting(false);
                          setReadingContext((current) => ({
                            key: readingKey,
                            enabled: current.key === readingKey ? !current.enabled : true,
                          }));
                        },
                        onSearch:
                          readingMode || ended || showConversation
                            ? undefined
                            : () => {
                                setConversationContext({ key: readingKey, wanted: false });
                                setSearchOpen(true);
                              },
                        onSelectText:
                          ended || showConversation
                            ? undefined
                            : () => {
                                setConversationContext({ key: readingKey, wanted: false });
                                setSelecting(true);
                              },
                        mouse: mouseSupported
                          ? {
                              enabled: mouseMode,
                              available: inputReady,
                              onToggle: () => {
                                setConversationContext({ key: readingKey, wanted: false });
                                setReadingContext({ key: readingKey, enabled: false });
                                setMouseContext({ key: readingKey, enabled: !mouseMode });
                              },
                            }
                          : undefined,
                      }}
                    />
                  ),
                }
          }
        />
        {keyboardVisible ? null : <TransportStatus fp={fp ?? ""} pausedOnly />}
        {mouseMode && !keyboardVisible ? (
          <Text
            accessibilityRole="text"
            accessibilityLiveRegion="polite"
            style={{
              color: tokens.textMuted,
              fontSize: 12,
              paddingHorizontal: 12,
              paddingVertical: 4,
            }}
          >
            Mouse on · tap a live terminal cell to click. Drag to scroll history.
          </Text>
        ) : null}
        <View style={{ flex: 1 }}>
          <View
            testID="terminal-layer"
            pointerEvents={showConversation ? "none" : "auto"}
            accessibilityElementsHidden={showConversation}
            importantForAccessibility={showConversation ? "no-hide-descendants" : "auto"}
            style={{ flex: 1, opacity: showConversation ? 0 : 1 }}
          >
            {ended ? (
              <EmptyState
                text="Session ended."
                action={{ label: "Back", onPress: () => router.back() }}
              />
            ) : !stream ? (
              <EmptyState text="Waiting for output…" />
            ) : (
              <ScreenView
                hideToolbar={keyboardVisible}
                terminalControls={terminalControls}
                inputReady={inputReady && terminalSupported && !readingMode && !showConversation}
                hardwareKeyboard={hardwareKeyboard}
                screenReader={screenReader}
                onInput={(data) => sendTerminalInput(data)}
                onPaste={
                  pasteSupported
                    ? (text, submit) => sendTerminalInput(text, true, submit)
                    : undefined
                }
                key={readingKey}
                readingMode={readingMode}
                mouseMode={mouseMode}
                onMouseClick={sendMouse}
                onVtStatus={(status) => {
                  if (stream.vt) setVtContext({ log: stream.vt.log, status });
                }}
                onVtError={(source, reason) =>
                  focusedLease?.rendererError(source, reason, viewRevision)
                }
                onVtReady={(source) => focusedLease?.rendererReady(source, viewRevision)}
                stream={stream}
                fallbackScreen={fallbackScreen}
                accent={accent}
                blinking={cursorBlinks(session?.state ?? "unknown")}
                inferredCursor={cursorIsInferred(session?.backend ?? "")}
                onLoadOlder={loadOlder}
                onSkipOversized={() => focusedLease?.skipOversized(viewRevision)}
                onRefreshHistory={() => focusedLease?.refreshHistory(viewRevision)}
                onRetryOutput={() => focusedLease?.retryOutput(viewRevision)}
                outputRetrying={outputRetrying}
                onProtectHistory={(key) => focusedLease?.protectHistory(key, viewRevision)}
                searchOpen={searchOpen && !readingMode}
                onSearchOpenChange={setSearchOpen}
                selecting={selecting}
                onSelectingChange={(value) => {
                  if (value) setConversationContext({ key: readingKey, wanted: false });
                  setSelecting(value);
                }}
                onSelectionChange={setHasSelection}
                onCopied={() => setSelecting(false)}
              />
            )}
          </View>
          {showConversation && !ended ? (
            <View style={{ position: "absolute", inset: 0 }}>
              <ConversationView
                key={conversation?.subscriptionId ?? "opening"}
                snapshot={conversation?.snapshot ?? OPENING_SNAPSHOT}
                onLoadOlder={loadOlderConversation}
                working={session?.state === "running"}
                agent={session?.agent?.kind}
              />
            </View>
          ) : null}
          {/* Spec 12: dim the last screen; never unmount it. */}
          {dimmed && stream && !ended ? <StatusOverlay text={overlay} tone="muted" /> : null}
        </View>
        {ended ? null : (
          <InputBar
            key={readingKey}
            onSubmitLine={terminalSupported ? submitTerminalLine : undefined}
            onTerminalInput={terminalSupported ? (data) => sendTerminalInput(data) : undefined}
            // A raw stream's xterm knows best, but only for terminals whose computer tracks it;
            // Herdr's stream is redrawn without the alternate screen, so it stays unknown.
            alternateScreen={
              facts.alternateReal
                ? raw
                  ? vtStatus?.alternate
                  : session?.alternateScreen
                : undefined
            }
            liveKeysAllowed={facts.alternateReal}
            agent={session?.agent}
            sessionState={session?.state}
            secretPrompt={facts.secret}
            terminalControls={
              terminalSupported && !readingMode && !showConversation ? terminalControls : undefined
            }
            hardwareKeyboard={hardwareKeyboard}
            availableHeight={availableHeight}
            fp={fp ?? ""}
            sessionId={sessionId}
            accent={accent}
            showChips={
              facts.cursorReal &&
              wantsReply(session?.state ?? "unknown", conn?.events[sessionId]?.at(-1)?.kind)
            }
          />
        )}
      </View>
    </KeyboardAvoidingView>
  );
}
