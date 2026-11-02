import {
  CONVERSATION_FEATURE,
  type SessionChat,
  type TerminalMouseClick,
} from "@shellbell/protocol";
import * as Haptics from "expo-haptics";
import { useKeepAwake } from "expo-keep-awake";
import { Stack, useFocusEffect, useLocalSearchParams, useRouter } from "expo-router";
import { useHeaderHeight } from "expo-router/react-navigation";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { BackHandler, Pressable, Text, View } from "react-native";
import {
  KeyboardAvoidingView,
  KeyboardController,
  useKeyboardState,
} from "react-native-keyboard-controller";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { ActivityBar } from "../../../../src/conversation/ActivityBar";
import { turnHaptic } from "../../../../src/conversation/activity";
import {
  ChatChecking,
  ChatExitedCard,
  ChatNotice,
  ChatOpening,
  ChatStart,
  ChatUnavailableBanner,
} from "../../../../src/conversation/ChatPlaceholders";
import {
  CODEX_INTEGRATION_HINT,
  ConversationView,
  conversationUnavailable,
} from "../../../../src/conversation/ConversationView";
import {
  type ChatConversationState,
  type ChatMode,
  chatMode,
  preferredMode,
  type TemporaryView,
} from "../../../../src/conversation/chat-mode";
import {
  chatComposerHold,
  chatNoneText,
  chatSwitchNotice,
} from "../../../../src/conversation/chat-status";
import {
  changedLines,
  nextTail,
  PRIVATE_LINES_MAX,
  SECRET_SETTLE_MS,
  tailLine,
} from "../../../../src/conversation/liveTail";
import { Fade } from "../../../../src/conversation/motion";
import { QueuedList } from "../../../../src/conversation/QueuedList";
import { ReceiptView } from "../../../../src/conversation/ReceiptView";
import {
  localRefusal,
  RECEIPT_SENT_FADE_MS,
  receiptFromOutcome,
  refusalText,
  type SendReceipt,
  sendingReceipt,
  settleReceipt,
} from "../../../../src/conversation/receipt";
import { WaitingCard } from "../../../../src/conversation/WaitingCard";
import { agentWaiting } from "../../../../src/conversation/waiting";
import { blockedPrompt } from "../../../../src/input/agentPrompt";
import {
  type ComposedInputResult,
  fireInput,
  INPUT_DELIVERY_UNKNOWN,
  withDeliveryTimeout,
} from "../../../../src/input/fireInput";
import { InputBar } from "../../../../src/input/InputBar";
import { inputTextExceedsLimit } from "../../../../src/input/limits";
import { lineText, textScreen } from "../../../../src/input/secretPrompt";
import { terminalInputFacts } from "../../../../src/input/terminalFacts";
import { useHardwareKeyboard } from "../../../../src/input/useHardwareKeyboard";
import { useScreenReader } from "../../../../src/input/useScreenReader";
import { conversationCache } from "../../../../src/net/conversation-cache";
import { connectionManager, type FocusedViewLease } from "../../../../src/net/manager";
import type { MobileConversationSnapshot } from "../../../../src/net/mobile-conversation";
import { dismissComputerNotifications } from "../../../../src/notifications";
import { ScreenView } from "../../../../src/screen/ScreenView";
import { chosenModeKey, useChosenModes } from "../../../../src/store/chosen-modes";
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
import { transportPaused } from "../../../../src/util/transport-state";

/** The last rows Chat showed, kept read-only under the banner while it can't update. */
function lastRowsSnapshot(
  snapshot: Readonly<MobileConversationSnapshot>,
): Readonly<MobileConversationSnapshot> {
  return {
    ...snapshot,
    state: "ready",
    historyStatus: "idle",
    canRequestOlder: false,
    caughtUp: null,
    notice: null,
    reason: null,
  };
}

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
  // `null` until the owner picks a view; then their choice wins over the agent's default. This
  // copy lasts as long as the screen; a session with a terminal instance also keeps it saved.
  const [chosenContext, setChosenContext] = useState<{ key: string; chosen: ChatMode | null }>({
    key: readingKey,
    chosen: null,
  });
  /** The agent this view last saw, so a session whose agent quit keeps showing its chat. */
  const [agentContext, setAgentContext] = useState<{ key: string; kind: string } | null>(null);
  /** Whether the focus effect's claim should ask for raw output; set once mouse mode is known. */
  const rawWantedRef = useRef(!readingMode);
  const [mouseContext, setMouseContext] = useState({ key: readingKey, enabled: false });
  const mousePending = useRef<symbol | null>(null);
  // Search and selection are opened from the session menu or a long press, not a toolbar.
  const [searchOpen, setSearchOpen] = useState(false);
  const [selecting, setSelecting] = useState(false);
  const [hasSelection, setHasSelection] = useState(false);
  useEffect(() => {
    setReadingContext({ key: readingKey, enabled: false });
    setChosenContext({ key: readingKey, chosen: null });
    setAgentContext(null);
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
  const instance = session?.instance;
  const savedChosen = useChosenModes((s) =>
    fp && instance ? (s.entries[chosenModeKey(fp, sessionId, instance)] ?? null) : null,
  );
  const chosen = savedChosen ?? (chosenContext.key === readingKey ? chosenContext.chosen : null);
  const choose = (mode: ChatMode) => {
    setChosenContext({ key: readingKey, chosen: mode });
    if (fp && instance) useChosenModes.getState().choose(fp, sessionId, instance, mode);
  };
  // An automatic session follows its agent; one that quits leaves the last agent's view showing.
  const currentAgentKind = session?.agent?.kind;
  useEffect(() => {
    if (
      currentAgentKind &&
      (agentContext?.key !== readingKey || agentContext.kind !== currentAgentKind)
    )
      setAgentContext({ key: readingKey, kind: currentAgentKind });
  }, [currentAgentKind, agentContext, readingKey]);
  // The computer's chat status. A list that had to leave this session out says nothing about
  // it, so the last status stands until a complete list does.
  const chatMemory = useRef<{ key: string; chat: SessionChat | undefined } | null>(null);
  if (session) chatMemory.current = { key: readingKey, chat: session.chat };
  const chat = session
    ? session.chat
    : conn?.sessionsComplete === false && chatMemory.current?.key === readingKey
      ? chatMemory.current.chat
      : undefined;
  /** The chat the session list says is current; a hint for what to open, never for input. */
  const chatId = chat?.state === "found" ? chat.id : undefined;
  const agentKind =
    currentAgentKind ??
    chat?.agent ??
    (agentContext?.key === readingKey ? agentContext.kind : undefined);
  /** Whether to hold the conversation subscription; kept while chat is briefly off or hidden. */
  const conversationWanted = preferredMode(chosen, agentKind, chat) === "chat";
  const conversationWantedRef = useRef(conversationWanted);
  conversationWantedRef.current = conversationWanted;
  const mouseSupported =
    activeBackends(conn?.hello).find((backend) => backend.name === session?.backend)?.capabilities
      .mouseClick === true;
  const inputReady = !transportPaused(conn);
  const terminalSupported =
    activeBackends(conn?.hello).find((backend) => backend.name === session?.backend)?.capabilities
      .terminalInput === true;
  const pasteSupported =
    activeBackends(conn?.hello).find((backend) => backend.name === session?.backend)?.capabilities
      .terminalPaste === true;
  const toast = (message: string) =>
    useConnectionsStore.getState().patch(fp ?? "", () => ({ toast: message }));
  // Secret input lives in the composer; the screen readers here must know when it is open.
  const [secretActive, setSecretActive] = useState(false);
  /**
   * A secret was sent during this step: its echo may arrive at any time until the step ends, so
   * the screen stays private until then, and for at least `SECRET_SETTLE_MS`.
   */
  const secretHold = useRef<{ step: string | null; at: number } | null>(null);
  const runningStepNow = useRef<string | null>(null);
  /** The latest send from Chat; a new send replaces it and a tap dismisses it. */
  const [receiptContext, setReceiptContext] = useState<{
    key: string;
    receipt: SendReceipt | null;
  }>({ key: readingKey, receipt: null });
  const receipt = receiptContext.key === readingKey ? receiptContext.receipt : null;
  const updateReceipt = (next: (current: SendReceipt | null) => SendReceipt | null) =>
    setReceiptContext((context) => ({
      key: readingKey,
      receipt: next(context.key === readingKey ? context.receipt : null),
    }));
  /**
   * Sends terminal input, or says in plain words why the phone can't (an empty string when there
   * is simply nothing to send).
   */
  const fireTerminalInput = (
    data: string,
    paste = false,
    submit = false,
    requestId?: string,
    /** The chat on screen, for input sent from Chat; the computer refuses it if it changed. */
    expectChat?: string,
  ): Promise<unknown> | string => {
    const c = connectionManager.get(fp ?? "");
    if (!data) return "";
    if (!terminalSupported) return "This terminal doesn’t take typed input from the phone.";
    if (!inputReady) return "Not sent while the connection is paused. Your draft is still here.";
    if (!c?.online) return "Not sent: your computer isn’t connected. Your draft is still here.";
    const reqId = requestId ?? c.newReqId();
    const expect = expectChat ? { expect: { chat: expectChat } } : {};
    const message = paste
      ? { type: "input.paste" as const, reqId, sessionId, text: data, submit, ...expect }
      : {
          type: "input.terminal" as const,
          reqId,
          sessionId,
          data: data + (submit ? "\r" : ""),
          ...expect,
        };
    if (inputTextExceedsLimit(message)) return "Too long to send in one go. Send a shorter part.";
    return fireInput(c, message, pendingInputHooks(fp ?? "", sessionId));
  };
  const sendTerminalInput = (data: string, paste = false, submit = false) => {
    const sent = fireTerminalInput(data, paste, submit);
    if (typeof sent === "string") {
      if (sent) toast(sent);
      return false;
    }
    void sent.then((outcome) => {
      const result = receiptFromOutcome("", outcome, agentKind);
      if (result.state === "refused") toast(result.text);
    });
    return true;
  };
  /**
   * The composer's send. In Chat its outcome is the receipt under the conversation; in Terminal a
   * refusal is a toast. After 10 s without an ack the outcome is unknown, the draft stays, and a
   * late ack still updates the receipt.
   */
  const submitTerminalLine = async (text: string, reqId: string): Promise<ComposedInputResult> => {
    const inChat = showConversation;
    const agent = agentKind;
    const report = (next: SendReceipt) => {
      if (inChat) updateReceipt((current) => settleReceipt(current, next));
      else if (next.state === "refused") toast(next.text);
    };
    const expectChat = inChat ? inputChat : undefined;
    if (inChat) updateReceipt(() => sendingReceipt(reqId));
    // Chat sends only into the conversation it shows; without a found chat there is none to name.
    if (inChat && chat && !expectChat) {
      report(localRefusal(reqId, "Not sent: the chat is still opening. Your draft is still here."));
      return false;
    }
    const sent = fireTerminalInput(
      text.replace(/\r?\n/g, "\r"),
      pasteSupported,
      true,
      reqId,
      expectChat,
    );
    if (typeof sent === "string") {
      report(localRefusal(reqId, sent || refusalText(undefined, agent)));
      return false;
    }
    const outcome = await withDeliveryTimeout(sent, (late) =>
      report(receiptFromOutcome(reqId, late, agent)),
    );
    const result = receiptFromOutcome(reqId, outcome, agent);
    report(result);
    if (result.state === "unknown") return INPUT_DELIVERY_UNKNOWN;
    return result.state === "sent";
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
  /** The session is the screen on top, so a haptic is for something the owner is looking at. */
  const onScreen = useRef(false);
  /**
   * Another screen covers this one, which stays mounted. Its rows live on only in the
   * conversation cache, so they expire after two minutes and on a memory warning.
   */
  const covered = useRef(false);
  const releaseRows = useRef(() => {});

  useFocusEffect(
    useCallback(() => {
      onScreen.current = true;
      covered.current = false;
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
        onScreen.current = false;
        covered.current = true;
        releaseRows.current();
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
  // The session left the computer's `sessions` list but a cached stream remains: it ended, and
  // the app must stop offering input for it (R59 ruling 1). The second disjunct only applies
  // while genuinely online (M7): otherwise a cold deep-link/notification tap into a session the
  // app has never fetched (`sessions` not loaded yet, or mid-reconnect) would render "Session
  // ended." for a session that may well still be running.
  const ended =
    sessionEnded(conn?.sessions ?? [], sessionId, stream, conn?.sessionsComplete !== false) ||
    (conn?.status === "online" && conn.sessionsComplete !== false && !session && !stream);
  const chatOffered =
    conn?.hello?.conversationEnabled === true &&
    conn.hello.features?.includes(CONVERSATION_FEATURE) === true;
  const temporaryView: TemporaryView | null = selecting
    ? "selection"
    : searchOpen
      ? "search"
      : readingMode
        ? "reading"
        : mouseMode
          ? "mouse"
          : null;
  // A closed subscription is about to be replaced, so Chat keeps opening rather than flipping.
  const snapshotState = conversation?.snapshot.state;
  const conversationState: ChatConversationState | undefined =
    snapshotState === "ended" ? undefined : snapshotState;
  const { mode, shows } = chatMode({
    chosen,
    agentKind,
    chatOffered,
    temporaryView,
    conversationState,
    ended,
    ...(chat ? { chat } : {}),
  });
  const showConversation = shows !== "terminal";
  // Rows stay on screen, read-only, while the computer can't send new ones: under a banner or
  // the exited card, or dimmed while it opens the same chat again. Memory only.
  const lastRows = useRef<{
    key: string;
    chat: string | undefined;
    agent: string | undefined;
    snapshot: Readonly<MobileConversationSnapshot>;
  } | null>(null);
  releaseRows.current = () => {
    lastRows.current = null;
  };
  // Gone with the view, once the owner turns chat off, and while another screen covers this one.
  if (
    lastRows.current?.key !== readingKey ||
    !chatOffered ||
    conversationState === "disabled" ||
    covered.current
  )
    lastRows.current = null;
  // Coming back within two minutes: the rows kept in memory show at once, dimmed, until the
  // computer's first page replaces them.
  if (!lastRows.current && !covered.current && chatOffered && conversationState !== "disabled") {
    const kept = conversationCache.peek(fp ?? "", sessionId);
    if (kept) lastRows.current = { key: readingKey, ...kept };
  }
  const liveEntries = conversation?.snapshot.entries.length ?? 0;
  /** The chat the rows on screen belong to, as their own stream named it (chat-v2). */
  const streamChat = conversation?.snapshot.chat ?? undefined;
  /**
   * The session list already names another chat than the rows on screen: the computer has
   * moved on, and its clear and first page for the new chat haven't arrived yet.
   */
  const staleRows =
    liveEntries > 0 && chatId !== undefined && streamChat !== undefined && streamChat !== chatId;
  /**
   * Input from Chat names the chat of the rows on screen, and only while the session list
   * agrees. A computer that tracks chats but whose stream hasn't named one yet gets no input.
   */
  const notStarted = chat?.state === "none" && chat.reason === "not-started";
  // A new agent's first message names the session's start id: there is no stream to name one.
  // Once its conversation is found, input goes back to naming the stream's own chat.
  const inputChat = notStarted ? chat.id : chat && !staleRows ? streamChat : undefined;
  if (conversation && liveEntries > 0 && !covered.current)
    lastRows.current = {
      key: readingKey,
      chat: streamChat ?? chatId,
      agent: agentKind,
      snapshot: conversation.snapshot,
    };
  // Rows belong to one chat: a different chat never shows them, dimmed or not.
  const keptRows =
    lastRows.current && (chatId === undefined || lastRows.current.chat === chatId)
      ? lastRows.current
      : null;
  /** The same chat opening again: its earlier rows stay, dimmed, until the new page swaps in. */
  const dimmedRows = staleRows
    ? lastRows.current
    : shows === "opening" && liveEntries === 0 && keptRows && keptRows.chat === chatId
      ? keptRows
      : null;
  // A first message to a new agent: until its conversation's first page arrives, Chat stays an
  // empty chat rather than flashing "Opening…", and the receipt holds the message meanwhile.
  const fromStart = useRef<{ key: string; on: boolean }>({ key: readingKey, on: false });
  if (fromStart.current.key !== readingKey) fromStart.current = { key: readingKey, on: false };
  if (notStarted) fromStart.current.on = true;
  else if (liveEntries > 0 || !(chat?.state === "found" || chat?.state === "finding"))
    fromStart.current.on = false;
  const awaitingFirstPage = fromStart.current.on && liveEntries === 0;
  // "Sent" fades 5 s after the computer confirmed it. Only a different send's confirmation
  // restarts the five seconds, never a re-render or the same confirmation settling again.
  // A new agent's first message stays on its receipt until the first page shows it.
  const sentId = receipt?.state === "sent" && !awaitingFirstPage ? receipt.id : null;
  useEffect(() => {
    if (sentId === null) return;
    const timer = setTimeout(
      () =>
        setReceiptContext((context) =>
          context.receipt?.id === sentId && context.receipt.state === "sent"
            ? { ...context, receipt: null }
            : context,
        ),
      RECEIPT_SENT_FADE_MS,
    );
    return () => clearTimeout(timer);
  }, [sentId]);
  /** Under the exited card or a banner, only the same agent's last rows stay. */
  const readOnlyRows =
    (shows === "exited" || shows === "unavailable-banner") &&
    lastRows.current &&
    (!chat?.agent || lastRows.current.agent === chat.agent)
      ? lastRows.current
      : null;
  // A different chat replaces the old rows; the notice says why the screen changed.
  const seenChat = useRef<{ key: string; id: string; agent?: string } | null>(null);
  const [switchNotice, setSwitchNotice] = useState<{ key: string; text: string } | null>(null);
  const chatAgent = chat?.agent;
  useEffect(() => {
    if (chatId === undefined) return;
    const seen = seenChat.current?.key === readingKey ? seenChat.current : null;
    if (seen && seen.id !== chatId)
      setSwitchNotice({
        key: readingKey,
        text: chatSwitchNotice(seen, chatAgent ? { agent: chatAgent } : {}),
      });
    seenChat.current = { key: readingKey, id: chatId, ...(chatAgent && { agent: chatAgent }) };
  }, [chatId, chatAgent, readingKey]);
  const notice =
    switchNotice?.key === readingKey && chatOffered && conversationState !== "disabled"
      ? switchNotice.text
      : null;
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
  // The screen the computer streams under Chat: the raw terminal's rows, or the snapshot.
  const liveScreen = vtStatus
    ? textScreen(vtStatus.rows, vtStatus.cursorY)
    : (stream?.screen ?? fallbackScreen);
  // Text rows for the agent's status line; the same screen, read on the phone only.
  const snapshotScreen = stream?.screen ?? fallbackScreen;
  const screenRows = useMemo(
    () => vtStatus?.rows ?? snapshotScreen?.lines.map(lineText) ?? null,
    [vtStatus, snapshotScreen],
  );
  /** Only Chat stops for an answer; the terminal is where it is given. */
  const waiting =
    showConversation && agentKind
      ? agentWaiting({
          sessionState: session?.state,
          prompt: liveScreen ? blockedPrompt(liveScreen) : null,
          secret: facts.secret,
        })
      : null;
  // The terminal's latest changed lines, for the running step's live tail. Hidden while a
  // password prompt is on screen; its identity holds while nothing changes, so idle Chat is still.
  const tailMemory = useRef<{
    key: string;
    rows: readonly string[] | null;
    tail: readonly string[];
    step: string | null;
    /** Lines seen while the screen was private; none of them is ever shown. */
    unseen: Set<string>;
  }>({ key: readingKey, rows: null, tail: [], step: null, unseen: new Set() });
  if (tailMemory.current.key !== readingKey)
    tailMemory.current = { key: readingKey, rows: null, tail: [], step: null, unseen: new Set() };
  const working = session?.state === "running";
  // The step now running: the newest entry, while it is a call still waiting for its result.
  const newestEntry = conversation?.snapshot.entries.at(-1);
  const runningStep = newestEntry?.kind === "tool-call" ? newestEntry.id : null;
  runningStepNow.current = runningStep;
  // A secret's hold ends once its step has changed or the turn has finished, and not before
  // 2 s. Blocked or unknown is not finished: the same step can resume and echo the secret.
  const turnFinished =
    runningStep === null && (session?.state === "finished" || session?.state === "editing");
  const hold = secretHold.current;
  if (
    hold &&
    Date.now() - hold.at >= SECRET_SETTLE_MS &&
    (runningStep !== hold.step || turnFinished)
  )
    secretHold.current = null;
  /**
   * Nothing read from the screen while a password prompt shows, Secret input is open, or a
   * secret sent in this step may still echo: a long secret's echo can wrap past any prompt row
   * the filters know, and arrive late.
   */
  const privateScreen = facts.secret || secretActive || secretHold.current !== null;
  // A new step starts its own tail: lines printed for the one before don't belong under it.
  if (runningStep !== tailMemory.current.step) {
    tailMemory.current.step = runningStep;
    if (tailMemory.current.tail.length) tailMemory.current.tail = [];
  }
  if (!working && tailMemory.current.tail.length) tailMemory.current.tail = [];
  if (screenRows && screenRows !== tailMemory.current.rows) {
    const memory = tailMemory.current;
    if (privateScreen) {
      // Remember what was on screen so it can't enter the tail later, even scrolled to a new row.
      for (const raw of screenRows) {
        const line = tailLine(raw);
        if (line && memory.unseen.size < PRIVATE_LINES_MAX) memory.unseen.add(line);
      }
    } else if (working)
      memory.tail = nextTail(
        memory.tail,
        changedLines(memory.rows, screenRows).filter((line) => !memory.unseen.has(line)),
      );
    memory.rows = screenRows;
  }
  if (privateScreen && tailMemory.current.tail.length) tailMemory.current.tail = [];
  const liveTail =
    showConversation && working && !privateScreen && tailMemory.current.tail.length
      ? tailMemory.current.tail
      : null;
  // A light tap when the agent finishes its turn or starts waiting for you, in Chat on screen.
  const waitingNow = waiting !== null;
  const turn = useRef<{ key: string; working: boolean; waiting: boolean } | null>(null);
  useEffect(() => {
    const before = turn.current?.key === readingKey ? turn.current : null;
    const after = { key: readingKey, working, waiting: waitingNow };
    turn.current = after;
    if (before && onScreen.current && showConversation && turnHaptic(before, after))
      void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light).catch(() => undefined);
  }, [working, waitingNow, readingKey, showConversation]);
  const composerHold = chatComposerHold({
    shows,
    chat,
    waiting: waiting !== null,
    dimmed: dimmedRows !== null || (chat?.state === "found" && !inputChat),
    agent: agentKind,
  });
  const sendEscape = () => {
    const c = connectionManager.get(fp ?? "");
    if (!inputReady || !c?.online) {
      toast("Not sent: your computer isn’t connected.");
      return;
    }
    void fireInput(
      c,
      { type: "input.key", reqId: c.newReqId(), sessionId, key: "esc" },
      pendingInputHooks(fp ?? "", sessionId),
    ).then((outcome) => {
      const result = receiptFromOutcome("", outcome, agentKind);
      if (result.state === "refused") toast(result.text);
    });
  };
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

  const backend = session ? backendLabel(session.backend, conn?.hello?.backendCatalog) : "";
  const name = session ? sessionTitle(session) : "Session";
  const sourceLabel = conn?.quiet
    ? "Not answering"
    : showConversation
      ? shows !== "conversation"
        ? "Chat"
        : conversation?.snapshot.caughtUp === false
          ? "Catching up"
          : "Chat"
      : stream?.output
        ? { live: "Live", "catching-up": "Catching up", paused: "Paused", ended: "Ended" }[
            stream.output.state
          ]
        : undefined;
  const statusLine =
    [
      sourceLabel,
      mode === "chat" && conversation && session?.agent
        ? (conversationUnavailable(conversation.snapshot, session.agent.kind) ??
          sessionStatusLine(session, backend))
        : session
          ? sessionStatusLine(session, backend)
          : undefined,
    ]
      .filter(Boolean)
      .join(" · ") || undefined;
  /** Chat from the menu or the header: leaves any temporary view and records the pick. */
  const showChat = () => {
    if (mode === "chat" && conversation?.snapshot.state === "unavailable")
      focusedLease?.refreshConversation(conversationRevision);
    if (conversation?.snapshot.reason === "unbound" && session?.agent?.kind === "codex")
      useConnectionsStore.getState().patch(fp ?? "", () => ({ toast: CODEX_INTEGRATION_HINT }));
    setReadingContext({ key: readingKey, enabled: false });
    setMouseContext({ key: readingKey, enabled: false });
    setSearchOpen(false);
    setSelecting(false);
    choose("chat");
  };
  const dimmed = transportPaused(conn);
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
                              onConversation: showChat,
                              onTerminal: () => choose("terminal"),
                            }
                          : undefined,
                        onToggleReading: () => {
                          setMouseContext({ key: readingKey, enabled: false });
                          setSearchOpen(false);
                          setSelecting(false);
                          setReadingContext((current) => ({
                            key: readingKey,
                            enabled: current.key === readingKey ? !current.enabled : true,
                          }));
                        },
                        // Search and selection show the terminal while open, then return.
                        onSearch: readingMode || ended ? undefined : () => setSearchOpen(true),
                        onSelectText: ended ? undefined : () => setSelecting(true),
                        mouse: mouseSupported
                          ? {
                              enabled: mouseMode,
                              available: inputReady,
                              onToggle: () => {
                                setReadingContext({ key: readingKey, enabled: false });
                                setMouseContext({ key: readingKey, enabled: !mouseMode });
                              },
                            }
                          : undefined,
                        // Agent sessions only: a plain shell has no chat to switch to.
                        modeToggle:
                          chatOffered && agentKind && !ended
                            ? {
                                chat: showConversation,
                                onToggle: () =>
                                  showConversation ? choose("terminal") : showChat(),
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
                onSelectingChange={setSelecting}
                onSelectionChange={setHasSelection}
                onCopied={() => setSelecting(false)}
              />
            )}
          </View>
          {showConversation ? (
            // Chat and Terminal cross-fade: Chat fades in over the terminal and out to reveal it.
            <Fade
              inMs={120}
              outMs={120}
              style={{ position: "absolute", inset: 0, backgroundColor: tokens.bg }}
            >
              <View style={{ flex: 1 }}>
                {notice ? <ChatNotice text={notice} /> : null}
                {shows === "unavailable-banner" ? (
                  <ChatUnavailableBanner
                    text={chat?.state === "none" ? chatNoneText(chat.reason, agentKind) : undefined}
                    onShowTerminal={() => choose("terminal")}
                  />
                ) : null}
                {shows === "start" ? (
                  <ChatStart agent={agentKind} />
                ) : shows === "unavailable-banner" || shows === "exited" ? (
                  readOnlyRows ? (
                    <ConversationView
                      key="last-rows"
                      snapshot={lastRowsSnapshot(readOnlyRows.snapshot)}
                      onLoadOlder={loadOlderConversation}
                      accent={accent}
                      agent={readOnlyRows.agent}
                    />
                  ) : null
                ) : conversation &&
                  !staleRows &&
                  (shows === "conversation" || conversation.snapshot.entries.length > 0) ? (
                  <ConversationView
                    key={conversation.subscriptionId}
                    snapshot={conversation.snapshot}
                    onLoadOlder={loadOlderConversation}
                    accent={accent}
                    working={session?.state === "running"}
                    agent={agentKind}
                    liveTail={liveTail}
                  />
                ) : dimmedRows ? (
                  <>
                    <ChatChecking />
                    <View
                      testID="chat-dimmed"
                      pointerEvents="none"
                      style={{ flex: 1, opacity: 0.5 }}
                    >
                      <ConversationView
                        key="last-rows"
                        snapshot={lastRowsSnapshot(dimmedRows.snapshot)}
                        onLoadOlder={loadOlderConversation}
                        accent={accent}
                        agent={dimmedRows.agent}
                      />
                    </View>
                  </>
                ) : awaitingFirstPage ? (
                  <ChatStart agent={agentKind} quiet={!notStarted} />
                ) : (
                  <ChatOpening agent={agentKind} />
                )}
              </View>
              {receipt ? (
                <ReceiptView
                  key={receipt.id}
                  receipt={receipt}
                  onDismiss={() => updateReceipt(() => null)}
                />
              ) : null}
              {agentKind ? (
                <ActivityBar
                  key={readingKey}
                  agentKind={agentKind}
                  sessionState={session?.state}
                  stateSince={session?.stateSince}
                  activeAt={session?.activeAt}
                  screenRows={screenRows}
                  waiting={waiting !== null}
                  secret={privateScreen}
                />
              ) : null}
              {shows === "conversation" ? (
                <QueuedList queued={conversation?.snapshot.queued} agent={agentKind} />
              ) : null}
              {shows === "exited" ? (
                <ChatExitedCard agent={agentKind} onShowTerminal={() => choose("terminal")} />
              ) : null}
              {waiting ? (
                <WaitingCard
                  agent={agentKind}
                  question={waiting.question}
                  onEscape={sendEscape}
                  onShowTerminal={() => choose("terminal")}
                />
              ) : null}
            </Fade>
          ) : null}
          {/* Spec 12: dim the last screen; never unmount it. */}
          {dimmed && (stream || showConversation) && !ended ? (
            <StatusOverlay text={overlay} tone="muted" />
          ) : null}
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
            receipts={showConversation}
            chatInput={showConversation}
            hideKeys={showConversation && waiting !== null}
            onSecretChange={setSecretActive}
            onSecretSent={() => {
              secretHold.current = { step: runningStepNow.current, at: Date.now() };
            }}
            holdReason={composerHold}
            expectChat={showConversation ? inputChat : undefined}
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
