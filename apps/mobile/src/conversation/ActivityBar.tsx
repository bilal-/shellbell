import { useEffect, useRef, useState } from "react";
import { Text, View } from "react-native";
import { agentHarness } from "../agents/registry";
import { tokens } from "../theme/tokens";
import { ACTIVITY_FRESH_MS, activityBar } from "./activity";
import { readAgentStatus } from "./agentStatus";
import { BreathingDot } from "./motion";

/** Rows from the bottom of the screen that count as its activity. */
const ACTIVITY_ROWS = 30;

interface Track {
  screen: string | null;
  activeAt: number | undefined;
  status: string | null;
  statusAt: number | null;
  lastActivityAt: number | null;
  runningSince: number | null;
}

/**
 * Pinned above the composer in Chat while the agent works. It keeps its own one-second clock so
 * only this bar re-renders as the timer ticks. While the agent waits for you the waiting card
 * stands in its place, so this shows nothing then.
 */
export function ActivityBar({
  agentKind,
  sessionState,
  stateSince,
  activeAt,
  screenRows,
  waiting,
  secret,
}: {
  agentKind: string | undefined;
  sessionState: string | undefined;
  /** When the computer saw the state change, in its own clock. */
  stateSince: number | undefined;
  /** When the computer saw the screen change, in its own clock. */
  activeAt: number | undefined;
  screenRows: readonly string[] | null;
  waiting: boolean;
  secret: boolean;
}) {
  // Only re-renders this bar once a second; the time itself is read below.
  const [, setTick] = useState(0);
  useEffect(() => {
    const timer = setInterval(() => setTick((tick) => tick + 1), 1000);
    return () => clearInterval(timer);
  }, []);
  const at = Date.now();
  const recent = (time: number | undefined) =>
    time !== undefined && Math.abs(at - time) <= ACTIVITY_FRESH_MS;
  const rows = screenRows?.slice(-ACTIVITY_ROWS) ?? null;
  const screen = rows ? rows.join("\n") : null;
  const status = rows && !secret ? readAgentStatus(agentKind, rows) : null;
  const statusKey = status ? JSON.stringify(status) : null;
  const track = useRef<Track | null>(null);
  if (track.current === null) {
    // What was already on screen when Chat opened isn't evidence of work now; a computer time
    // within the last few seconds is.
    track.current = {
      screen,
      activeAt,
      status: statusKey,
      statusAt: status ? at : null,
      lastActivityAt: recent(activeAt) ? at : null,
      runningSince: null,
    };
  }
  const t = track.current;
  if (screen !== t.screen) {
    if (t.screen !== null && screen !== null) t.lastActivityAt = at;
    t.screen = screen;
  }
  if (activeAt !== t.activeAt) {
    if (activeAt !== undefined) t.lastActivityAt = at;
    t.activeAt = activeAt;
  }
  if (statusKey !== t.status) {
    t.status = statusKey;
    t.statusAt = status ? at : null;
  }
  if (sessionState === "running")
    t.runningSince ??= stateSince !== undefined && stateSince <= at ? stateSince : at;
  else t.runningSince = null;
  const bar = activityBar({
    agentKind,
    sessionState,
    waiting,
    secret,
    status,
    statusAt: t.statusAt,
    lastActivityAt: t.lastActivityAt,
    runningSince: t.runningSince,
    now: at,
  });
  if (!bar || bar.kind === "waiting") return null;
  const color = agentHarness(agentKind)?.color ?? tokens.textMuted;
  const words = [bar.label, bar.elapsed, bar.detail].filter(Boolean).join(" · ");
  return (
    <View
      testID="activity-bar"
      accessible
      accessibilityRole="text"
      accessibilityLabel={words}
      style={{
        flexDirection: "row",
        alignItems: "center",
        gap: 10,
        paddingHorizontal: 14,
        paddingVertical: 8,
        borderTopWidth: 1,
        borderTopColor: tokens.border,
        backgroundColor: `${color}1A`,
      }}
    >
      <BreathingDot color={color} size={12} />
      <Text numberOfLines={1} style={{ flexShrink: 1, color: tokens.text, fontSize: 13 }}>
        {bar.label}
      </Text>
      {bar.elapsed || bar.detail ? (
        <Text
          numberOfLines={1}
          style={{
            flexShrink: 1,
            color: tokens.textMuted,
            fontSize: 13,
            fontVariant: ["tabular-nums"],
          }}
        >
          {[bar.elapsed, bar.detail].filter(Boolean).join(" · ")}
        </Text>
      ) : null}
    </View>
  );
}
