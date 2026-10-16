import type { ScreenSnapshot, TerminalMouseClick } from "@shellbell/protocol";
import { FlashList, type FlashListRef } from "@shopify/flash-list";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ActivityIndicator, Pressable, Text, useWindowDimensions, View } from "react-native";
import { Gesture, GestureDetector } from "react-native-gesture-handler";
import { historyAcceptsOlder, type MobileStreamSnapshot } from "../net/mobile-screen-stream";
import { useUiStore } from "../store/computers";
import type { TerminalControls } from "../terminal/controls";
import { XtermView } from "../terminal/XtermView";
import { tokens } from "../theme/tokens";
import { JumpToLiveButton } from "../ui/JumpToLiveButton";
import { ReadingRow } from "./ReadingRow";
import { projectReadingRows, type ReadingDisplayRow } from "./reading-presentation";
import { SelectionSheet } from "./SelectionSheet";
import { type SelectionSnapshot, selectionSnapshot } from "./selection-snapshot";
import { OlderLoadIntent, projectStreamRows, type StreamDisplayRow } from "./stream-presentation";

type DisplayRow = ReadingDisplayRow;

export function ScreenView({
  stream,
  fallbackScreen,
  accent,
  blinking,
  inferredCursor,
  onLoadOlder,
  onSkipOversized,
  onRefreshHistory,
  onRetryOutput,
  outputRetrying = false,
  onProtectHistory,
  readingMode = false,
  hideToolbar = false,
  onRenderer,
  mouseMode = false,
  onMouseClick,
  terminalControls,
  inputReady = false,
  hardwareKeyboard = false,
  screenReader = false,
  onInput,
  onPaste,
  searchOpen = false,
  onSearchOpenChange,
  selecting = false,
  onSelectingChange,
  onSelectionChange,
  onCopied,
}: {
  stream?: MobileStreamSnapshot;
  fallbackScreen?: Readonly<ScreenSnapshot>;
  accent: string;
  blinking: boolean;
  inferredCursor: boolean;
  onLoadOlder: () => void;
  onSkipOversized?: () => void;
  onRefreshHistory?: () => void;
  onRetryOutput?: () => void;
  /** A transient close is being resubscribed automatically; show loading, not the failure. */
  outputRetrying?: boolean;
  onProtectHistory?: (key: string | null) => void;
  readingMode?: boolean;
  hideToolbar?: boolean;
  onRenderer?: (renderer: "webgl" | "dom") => void;
  mouseMode?: boolean;
  onMouseClick?: (click: TerminalMouseClick) => void;
  terminalControls?: TerminalControls;
  inputReady?: boolean;
  hardwareKeyboard?: boolean;
  screenReader?: boolean;
  onInput?: (data: string) => boolean;
  onPaste?: (text: string, submit: boolean) => boolean;
  /** Terminal search, opened from the session menu. */
  searchOpen?: boolean;
  onSearchOpenChange?: (open: boolean) => void;
  /**
   * Text selection requested by the session menu or a long press. The terminal selects in
   * place; Reading view opens a snapshot of the visible paragraphs once they are known.
   */
  selecting?: boolean;
  onSelectingChange?: (selecting: boolean) => void;
  onSelectionChange?: (selected: boolean) => void;
  onCopied?: () => void;
}) {
  const { width } = useWindowDimensions();
  const [paneWidth, setPaneWidth] = useState<number | null>(null);
  const viewportWidth = paneWidth ?? width;
  const fontSizeSetting = useUiStore((s) => s.fontSize);
  const fitWidth = useUiStore((s) => s.fitWidth);
  const setFontSize = useUiStore((s) => s.setFontSize);
  const commitFontSize = useUiStore((s) => s.commitFontSize);
  const displayScreen = stream?.screen ?? fallbackScreen;
  const cols = displayScreen?.cols ?? 80;
  const fontSize = Math.max(12, fontSizeSetting);
  const lineHeight = fontSize * 1.25;
  const list = useRef<FlashListRef<DisplayRow>>(null);
  const [boundaryKey, setBoundaryKey] = useState<string | null>(null);
  const olderIntent = useRef(new OlderLoadIntent());
  // A drag authorizes loading only in the layout where that gesture began.
  // Identity changes even for Terminal -> Reading -> Terminal, so an old token
  // cannot become valid again after a round trip without another gesture.
  const historyLayout = useMemo(
    () => ({ readingMode, fontSize, viewportWidth }),
    [readingMode, fontSize, viewportWidth],
  );
  const dragLayout = useRef<typeof historyLayout | null>(null);
  // FlashList need not report again when resize/pinch retains the same visible items.
  const selectionMode = useMemo(() => ({ readingMode }), [readingMode]);
  const selectionLayout = useRef(selectionMode);
  selectionLayout.current = selectionMode;
  const [visibleRange, setVisibleRange] = useState<{
    layout: typeof selectionMode;
    top: string | null;
    bottom: string | null;
  } | null>(null);
  const protectHistoryRef = useRef(onProtectHistory);
  protectHistoryRef.current = onProtectHistory;
  const [following, setFollowing] = useState(true);
  const [focusedHistoryAction, setFocusedHistoryAction] = useState<string | null>(null);
  const startScale = useRef(fontSizeSetting);
  // Read fresh inside the gesture's worklet-adjacent JS callbacks without forcing the gesture
  // object itself to be rebuilt (M4) every time the setting changes.
  const fontSizeRef = useRef(fontSizeSetting);
  fontSizeRef.current = readingMode ? Math.max(12, fontSizeSetting) : fontSizeSetting;
  const rows = useMemo<readonly StreamDisplayRow[]>(
    () => (stream ? projectStreamRows(stream, fallbackScreen) : []),
    [stream, fallbackScreen],
  );

  const displayRows = useMemo<readonly DisplayRow[]>(
    () => (readingMode ? projectReadingRows(rows, boundaryKey) : []),
    [rows, boundaryKey, readingMode],
  );

  // Review I5: pinching used to call `setFontSize` (a synchronous SQLite write) on every gesture
  // frame -- ~60 blocking writes/sec on the same JS thread re-laying out every visible row.
  // `onUpdate` now only updates in-memory state; the SQLite write happens once, on `onEnd`.
  const pinch = useMemo(
    () =>
      Gesture.Pinch()
        .enabled(readingMode || !fitWidth)
        .onStart(() => {
          startScale.current = fontSizeRef.current;
        })
        .onUpdate((e) => setFontSize(Math.round(startScale.current * e.scale), { persist: false }))
        .onEnd(() => commitFontSize())
        .runOnJS(true),
    [readingMode, fitWidth, setFontSize, commitFontSize],
  );

  useEffect(() => {
    if (following) list.current?.scrollToEnd({ animated: false });
  }, [following]);

  // Stable cursor identity avoids bridge work when only unrelated session metadata changes.
  const cursor = useMemo(
    () =>
      (displayScreen?.cursor.y ?? -1) >= 0
        ? {
            x: displayScreen?.cursor.x ?? 0,
            y: displayScreen?.cursor.y ?? -1,
            accent,
            blinking,
            inferred: inferredCursor,
          }
        : null,
    [displayScreen?.cursor.x, displayScreen?.cursor.y, accent, blinking, inferredCursor],
  );

  const renderItem = useCallback(
    ({ item }: { item: DisplayRow }) =>
      item.kind === "gap" ? (
        <View style={{ minHeight: 48, justifyContent: "center", paddingHorizontal: 8 }}>
          <Text style={{ color: tokens.textMuted, fontSize: 13 }}>{item.label}</Text>
        </View>
      ) : (
        <ReadingRow
          paragraph={item}
          fontSize={fontSize}
          paneWidth={Math.max(1, viewportWidth - 16)}
        />
      ),
    [fontSize, viewportWidth],
  );

  const onViewableItemsChanged = useRef(
    ({ viewableItems }: { viewableItems: Array<{ item: DisplayRow }> }) => {
      const first = viewableItems[0]?.item;
      const last = viewableItems.at(-1)?.item;
      setVisibleRange({
        layout: selectionLayout.current,
        top: first?.key ?? null,
        bottom: last?.key ?? null,
      });
      const source = viewableItems.find(({ item }) => item.kind !== "gap")?.item;
      // Empty/gap-only notifications can occur during relayout. They do not
      // establish a new source anchor or surrender the history being read.
      if (!source) return;
      setBoundaryKey(source.key);
      let historyKey: string | null = null;
      for (const { item } of viewableItems) {
        if (item.kind === "paragraph") historyKey = item.historyKey;
        if (historyKey !== null) break;
      }
      protectHistoryRef.current?.(historyKey);
    },
  ).current;
  const historyStatus = stream?.historyStatus;
  const historyReadOnly = stream?.history?.readOnly ?? false;
  const outputStopped = stream?.status === "closed" && !outputRetrying;
  const outputStatus = outputStopped
    ? {
        stalled: "Output stopped: delivery stalled",
        "invalid-transfer": "Output stopped: invalid transfer",
        "screen-too-large": "Output stopped: screen too large",
        unsupported: "Output stopped: unsupported screen",
        "session-gone": "Output stopped: session ended",
      }[stream.error ?? "stalled"]
    : stream?.status === "loading" || stream?.status === "idle" || outputRetrying
      ? displayScreen
        ? "Updating output…"
        : "Waiting for output…"
      : null;
  const newerHistory = Boolean(
    stream?.history &&
      stream.screen &&
      stream.screen.scrollbackTotal > stream.history.anchor.before,
  );
  const canRefresh =
    (historyReadOnly ||
      newerHistory ||
      historyStatus === "reset" ||
      historyStatus === "truncated") &&
    (!outputStopped || Boolean(stream?.history));
  const canLoad = stream
    ? (!historyReadOnly || stream.historyRefreshPending) &&
      historyAcceptsOlder(stream.historyStatus) &&
      historyStatus !== "loading"
    : false;
  // Older pages load by reaching the top of the scrollback. Only a state that needs a person's
  // attention, or offers a choice, takes a row above the terminal.
  const historyNotice =
    historyStatus === "unavailable" ||
    historyStatus === "oversized" ||
    historyStatus === "limited" ||
    canRefresh;
  const loadingOlder = historyStatus === "loading";
  const action = (label: string, onPress: () => void) => (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      onPress={onPress}
      onFocus={() => setFocusedHistoryAction(label)}
      onBlur={() => setFocusedHistoryAction((current) => (current === label ? null : current))}
      style={({ pressed }) => ({
        minHeight: 48,
        justifyContent: "center",
        paddingHorizontal: 12,
        borderRadius: tokens.radius.sm,
        backgroundColor:
          pressed || focusedHistoryAction === label ? tokens.surface2 : "transparent",
      })}
    >
      <Text style={{ color: accent, fontSize: 15 }}>{label}</Text>
    </Pressable>
  );

  return (
    <GestureDetector gesture={pinch}>
      <View
        style={{ flex: 1, minHeight: 0, overflow: "hidden" }}
        onLayout={(event) => {
          // Height-only keyboard/rotation changes also invalidate old gestures.
          dragLayout.current = null;
          const next = event.nativeEvent.layout.width;
          if (Number.isFinite(next) && next > 0) setPaneWidth(next);
        }}
      >
        {outputStatus ? (
          <View
            style={{
              flexDirection: "row",
              flexWrap: "wrap",
              alignItems: "center",
              backgroundColor: tokens.surface,
              borderBottomColor: tokens.border,
              borderBottomWidth: 1,
              paddingHorizontal: 8,
            }}
          >
            <Text accessibilityLiveRegion="polite" style={{ color: tokens.text, fontSize: 15 }}>
              {outputStatus}
            </Text>
            {outputStopped && stream?.error !== "session-gone" && onRetryOutput
              ? action("Retry output", onRetryOutput)
              : null}
          </View>
        ) : null}
        {!hideToolbar && historyNotice ? (
          <View
            style={{
              flexDirection: "row",
              flexWrap: "wrap",
              alignItems: "center",
              backgroundColor: tokens.surface,
              borderBottomColor: tokens.border,
              borderBottomWidth: 1,
              paddingLeft: 4,
            }}
          >
            {historyStatus === "unavailable" ? (
              <Text style={{ color: tokens.textMuted, fontSize: 13, paddingHorizontal: 8 }}>
                Couldn’t load older lines just now
              </Text>
            ) : null}
            {historyStatus === "oversized" ? (
              <Text style={{ color: tokens.textMuted, fontSize: 13, paddingHorizontal: 8 }}>
                One line is too long to show
              </Text>
            ) : null}
            {historyStatus === "limited" ? (
              <Text
                style={{
                  color: tokens.textMuted,
                  fontSize: 13,
                  paddingHorizontal: 8,
                  paddingVertical: 8,
                }}
              >
                This terminal doesn’t share lines older than this
              </Text>
            ) : null}
            {canRefresh ? (
              <Text style={{ color: tokens.textMuted, fontSize: 13, paddingHorizontal: 8 }}>
                {historyStatus === "truncated"
                  ? "Older lines were trimmed to save memory"
                  : newerHistory && !historyReadOnly
                    ? "Newer lines are available"
                    : "Older lines stopped loading because the terminal kept changing"}
              </Text>
            ) : null}
            {canLoad && historyStatus === "unavailable"
              ? action("Retry history", onLoadOlder)
              : null}
            {historyStatus === "oversized" && onSkipOversized
              ? action("Skip line", onSkipOversized)
              : null}
            {canRefresh && onRefreshHistory ? action("Refresh history", onRefreshHistory) : null}
          </View>
        ) : null}
        {readingMode &&
        selecting &&
        visibleRange?.layout === selectionMode &&
        visibleRange.top &&
        visibleRange.bottom ? (
          <ReadingSelection
            take={() => {
              const first = displayRows.find((row) => row.key === visibleRange.top);
              const last = displayRows.find((row) => row.key === visibleRange.bottom);
              const top =
                first?.kind === "paragraph" ? (first.sourceKeys[0] ?? null) : visibleRange.top;
              const bottom =
                last?.kind === "paragraph" ? (last.sourceKeys.at(-1) ?? null) : visibleRange.bottom;
              return selectionSnapshot(rows, top, bottom);
            }}
            onClose={() => onSelectingChange?.(false)}
          />
        ) : null}
        {!readingMode ? (
          <XtermView
            hideToolbar={hideToolbar}
            controls={terminalControls}
            inputReady={inputReady}
            hardwareKeyboard={hardwareKeyboard}
            screenReader={screenReader}
            onInput={onInput}
            onPaste={onPaste}
            mouseMode={mouseMode}
            liveRows={displayScreen?.rows ?? 0}
            onMouseClick={onMouseClick}
            onRenderer={onRenderer}
            rows={rows}
            cols={cols}
            fontSize={fontSizeSetting}
            fitWidth={fitWidth}
            cursor={cursor}
            initialAnchor={following ? null : boundaryKey}
            onViewport={(anchor, live, topKey = anchor, bottomKey = null) => {
              setVisibleRange({ layout: selectionMode, top: topKey, bottom: bottomKey });
              setFollowing(live);
              if (topKey !== null) setBoundaryKey(topKey);
              protectHistoryRef.current?.(anchor);
            }}
            onLoadOlder={() => {
              if (canLoad) onLoadOlder();
            }}
            searchOpen={searchOpen}
            onSearchOpenChange={onSearchOpenChange}
            selecting={selecting}
            onSelectingChange={onSelectingChange}
            onSelectionChange={onSelectionChange}
            onCopied={onCopied}
          />
        ) : (
          <View style={{ flex: 1, width: viewportWidth }}>
            <FlashList
              ref={list}
              data={displayRows}
              keyExtractor={(row) => row.key}
              getItemType={(row) => row.kind}
              renderItem={renderItem}
              onViewableItemsChanged={onViewableItemsChanged}
              initialScrollIndex={
                !following && boundaryKey !== null
                  ? Math.max(
                      0,
                      displayRows.findIndex((row) => row.key === boundaryKey),
                    )
                  : undefined
              }
              maintainVisibleContentPosition={{
                startRenderingFromBottom: following,
                autoscrollToBottomThreshold: 0.1,
              }}
              onScrollBeginDrag={(e) => {
                dragLayout.current = historyLayout;
                if (olderIntent.current.beginDrag(e.nativeEvent.contentOffset.y <= 0) && canLoad)
                  onLoadOlder();
              }}
              onStartReached={() => {
                if (
                  olderIntent.current.consume() &&
                  dragLayout.current === historyLayout &&
                  canLoad
                )
                  onLoadOlder();
              }}
              onStartReachedThreshold={0.2}
              onScroll={(e) => {
                const { contentOffset, contentSize, layoutMeasurement } = e.nativeEvent;
                const atEnd =
                  contentOffset.y + layoutMeasurement.height >= contentSize.height - lineHeight * 2;
                setFollowing(atEnd);
              }}
              scrollEventThrottle={100}
              contentContainerStyle={{ paddingHorizontal: 8, paddingVertical: 4 }}
            />
          </View>
        )}
        {following || !readingMode ? null : (
          <JumpToLiveButton
            onPress={() => {
              setFollowing(true);
              list.current?.scrollToEnd({ animated: true });
            }}
          />
        )}
        {loadingOlder ? (
          <View
            accessible
            accessibilityLabel="Loading older history"
            accessibilityLiveRegion="polite"
            pointerEvents="none"
            style={{
              position: "absolute",
              top: 8,
              alignSelf: "center",
              flexDirection: "row",
              alignItems: "center",
              gap: 8,
              paddingHorizontal: 12,
              paddingVertical: 6,
              borderRadius: tokens.radius.lg,
              backgroundColor: tokens.surface2,
              borderWidth: 1,
              borderColor: tokens.border,
            }}
          >
            <ActivityIndicator size="small" color={tokens.textMuted} />
            <Text style={{ color: tokens.textMuted, fontSize: 13 }}>Loading older…</Text>
          </View>
        ) : null}
      </View>
    </GestureDetector>
  );
}

/** Freezes the visible paragraphs when selection opens; later output cannot move the text. */
function ReadingSelection({
  take,
  onClose,
}: {
  take: () => SelectionSnapshot | null;
  onClose: () => void;
}) {
  const [snapshot] = useState(take);
  // Nothing selectable is visible: end the request so the menu can make another.
  useEffect(() => {
    if (!snapshot) onClose();
  }, [snapshot, onClose]);
  return snapshot ? <SelectionSheet snapshot={snapshot} onClose={onClose} /> : null;
}
