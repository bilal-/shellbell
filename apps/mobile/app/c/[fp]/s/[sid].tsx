import type { TerminalMouseClick } from "@shellbell/protocol";
import { useKeepAwake } from "expo-keep-awake";
import { Stack, useFocusEffect, useLocalSearchParams, useRouter } from "expo-router";
import { useHeaderHeight } from "expo-router/react-navigation";
import { useCallback, useEffect, useRef, useState } from "react";
import { Pressable, Text, View } from "react-native";
import { KeyboardAvoidingView, useKeyboardState } from "react-native-keyboard-controller";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import {
  type ComposedInputResult,
  fireInput,
  INPUT_DELIVERY_UNKNOWN,
} from "../../../../src/input/fireInput";
import { InputBar } from "../../../../src/input/InputBar";
import { inputTextExceedsLimit } from "../../../../src/input/limits";
import { useHardwareKeyboard } from "../../../../src/input/useHardwareKeyboard";
import { useScreenReader } from "../../../../src/input/useScreenReader";
import { connectionManager, type FocusedViewLease } from "../../../../src/net/manager";
import { dismissComputerNotifications } from "../../../../src/notifications";
import { ScreenView } from "../../../../src/screen/ScreenView";
import { useComputersStore } from "../../../../src/store/computers";
import { pendingInputHooks, useConnectionsStore } from "../../../../src/store/connections";
import { useNetworkStore } from "../../../../src/store/network";
import { TerminalControls } from "../../../../src/terminal/controls";
import { tokens } from "../../../../src/theme/tokens";
import { EmptyState } from "../../../../src/ui/EmptyState";
import { SessionMenuButton } from "../../../../src/ui/SessionMenuButton";
import { StatusOverlay } from "../../../../src/ui/StatusOverlay";
import { TransportStatus } from "../../../../src/ui/TransportStatus";
import { activeBackends, backendLabel, cursorIsInferred } from "../../../../src/util/backends";
import { connectionNotice } from "../../../../src/util/connection-state";
import { sidFromRoute } from "../../../../src/util/routes";
import {
  cursorBlinks,
  sessionEnded,
  statePill,
  wantsReply,
} from "../../../../src/util/session-state";

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
  const [mouseContext, setMouseContext] = useState({ key: readingKey, enabled: false });
  const mousePending = useRef<symbol | null>(null);
  useEffect(() => {
    setReadingContext({ key: readingKey, enabled: false });
    setMouseContext({ key: readingKey, enabled: false });
    mousePending.current = null;
  }, [readingKey]);
  const computer = useComputersStore((s) => s.computers.find((c) => c.fp === fp));
  const conn = useConnectionsStore((s) => s.byComputer[fp ?? ""]);
  const session = conn?.sessions.find((s) => s.id === sessionId);
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
      const claimed = connectionManager.claimView(fp ?? "", sessionId);
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
      };
    }, [fp, sessionId]),
  );

  const view = conn?.view?.sessionId === sessionId ? conn.view.view : undefined;
  const stream = conn?.boundedView?.sessionId === sessionId ? conn.boundedView.snapshot : undefined;
  const fallbackScreen =
    conn?.boundedView?.sessionId === sessionId ? conn.boundedView.fallbackScreen : undefined;
  const focusedLease = lease.current;
  const viewRevision = focusedLease?.revision() ?? null;
  const loadOlder = useCallback(() => {
    focusedLease?.requestOlder(viewRevision);
  }, [focusedLease, viewRevision]);

  // The session left the computer's `sessions` list but a cached `view` remains: it ended, and
  // the app must stop offering input for it (R59 ruling 1). The second disjunct only applies
  // while genuinely online (M7): otherwise a cold deep-link/notification tap into a session the
  // app has never fetched (`sessions` not loaded yet, or mid-reconnect) would render "Session
  // ended." for a session that may well still be running.
  const ended =
    sessionEnded(conn?.sessions ?? [], sessionId, view ?? stream) ||
    (conn?.status === "online" && !session && !view && !stream);
  const pill = session ? statePill(session.state) : null;
  const title = session ? `${session.title}${pill ? ` · ${pill.label}` : ""}` : "Session";
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
          options={{
            title: readingMode ? `${title} · Reading` : title,
            headerBackTitle: session
              ? backendLabel(session.backend, conn?.hello?.backendCatalog)
              : undefined,
            headerRight: () => (
              <View style={{ flexDirection: "row", alignItems: "center", gap: 16 }}>
                <Pressable
                  accessibilityRole="button"
                  accessibilityLabel={
                    readingMode ? "Switch to terminal grid" : "Switch to reading view"
                  }
                  onPress={() => {
                    setMouseContext({ key: readingKey, enabled: false });
                    setReadingContext((current) => ({
                      key: readingKey,
                      enabled: current.key === readingKey ? !current.enabled : true,
                    }));
                  }}
                  hitSlop={8}
                  style={{ paddingVertical: 10 }}
                >
                  <Text style={{ color: accent, fontSize: 15 }}>
                    {readingMode ? "Terminal" : "Read"}
                  </Text>
                </Pressable>
                {mouseSupported ? (
                  <Pressable
                    accessibilityRole="button"
                    accessibilityLabel={
                      mouseMode ? "Turn off terminal mouse" : "Turn on terminal mouse"
                    }
                    accessibilityState={{ selected: mouseMode, disabled: !inputReady }}
                    disabled={!inputReady}
                    onPress={() => {
                      setReadingContext({ key: readingKey, enabled: false });
                      setMouseContext({ key: readingKey, enabled: !mouseMode });
                    }}
                    hitSlop={8}
                    style={{ paddingVertical: 10 }}
                  >
                    <Text style={{ color: mouseMode ? accent : tokens.textMuted, fontSize: 15 }}>
                      Mouse
                    </Text>
                  </Pressable>
                ) : null}
                <SessionMenuButton fp={fp ?? ""} sessionId={sessionId} />
              </View>
            ),
          }}
        />
        {keyboardVisible ? null : <TransportStatus fp={fp ?? ""} />}
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
          {ended ? (
            <EmptyState
              text="Session ended."
              action={{ label: "Back", onPress: () => router.back() }}
            />
          ) : !view && !stream ? (
            <EmptyState text="Waiting for output…" />
          ) : (
            <ScreenView
              hideToolbar={keyboardVisible}
              terminalControls={terminalControls}
              inputReady={inputReady && terminalSupported && !readingMode}
              hardwareKeyboard={hardwareKeyboard}
              screenReader={screenReader}
              onInput={(data) => sendTerminalInput(data)}
              onPaste={
                pasteSupported ? (text, submit) => sendTerminalInput(text, true, submit) : undefined
              }
              key={readingKey}
              readingMode={readingMode}
              mouseMode={mouseMode}
              onMouseClick={sendMouse}
              view={view}
              oldestAvailable={conn?.oldestAvailable[sessionId]}
              stream={stream}
              fallbackScreen={fallbackScreen}
              accent={accent}
              blinking={cursorBlinks(session?.state ?? "unknown")}
              inferredCursor={cursorIsInferred(session?.backend ?? "")}
              onLoadOlder={loadOlder}
              onSkipOversized={() => focusedLease?.skipOversized(viewRevision)}
              onRefreshHistory={() => focusedLease?.refreshHistory(viewRevision)}
              onRetryOutput={() => focusedLease?.retryOutput(viewRevision)}
              onProtectHistory={(key) => focusedLease?.protectHistory(key, viewRevision)}
            />
          )}
          {/* Spec 12: dim the last screen; never unmount it. */}
          {dimmed && (view || stream) && !ended ? (
            <StatusOverlay text={overlay} tone="muted" />
          ) : null}
        </View>
        {ended ? null : (
          <InputBar
            key={readingKey}
            onSubmitLine={terminalSupported ? submitTerminalLine : undefined}
            terminalControls={terminalSupported && !readingMode ? terminalControls : undefined}
            hardwareKeyboard={hardwareKeyboard}
            availableHeight={availableHeight}
            fp={fp ?? ""}
            sessionId={sessionId}
            accent={accent}
            showChips={wantsReply(
              session?.state ?? "unknown",
              conn?.events[sessionId]?.at(-1)?.kind,
            )}
          />
        )}
      </View>
    </KeyboardAvoidingView>
  );
}
