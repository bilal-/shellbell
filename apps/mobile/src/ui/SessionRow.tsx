import type { SessionInfoLoose } from "@shellbell/protocol";
import { Pressable, Text, View } from "react-native";
import { AgentMark } from "../agents/AgentMark";
import { tokens } from "../theme/tokens";
import { sessionAccessibilityLabel, sessionSubtitle, sessionTitle } from "../util/session-label";
import { statePill } from "../util/session-state";
import { AppIcon } from "./AppIcon";
import { Pill } from "./Pill";

/** Matches the subtitle's 12 pt line so an agent row and a folder row are the same height. */
const SUBTITLE_LINE = 16;

/**
 * One session in a computer's list: project as the title, then the agent and its task or the
 * home-relative folder. Both lines truncate with an ellipsis; the pills never shrink.
 */
export function SessionRow({
  session,
  backend,
  showBackend = true,
  accent,
  unread,
  onPress,
  status,
  place,
  dim = false,
  hint = "Open terminal",
}: {
  session: SessionInfoLoose;
  backend: string;
  /** Off when every listed session shares one backend: the pill would repeat on each row. */
  showBackend?: boolean;
  accent: string;
  unread: boolean;
  onPress: () => void;
  /** Replaces the state pill, as the Agents list does with "waiting for you · 2m". */
  status?: { label: string; tone: "muted" | "active" | "alert" };
  /** The terminal or workspace, to tell apart rows with the same project and task. */
  place?: string;
  /** A row quiet for hours. */
  dim?: boolean;
  hint?: string;
}) {
  const pill = status ?? statePill(session.state);
  const subtitle = sessionSubtitle(session);
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={sessionAccessibilityLabel(session, {
        backend,
        // An unrecognised state reads as its own words, so the Agents list's label is spoken.
        state: status?.label ?? session.state,
        unread,
      })}
      accessibilityHint={hint}
      onPress={onPress}
      style={{
        opacity: dim ? 0.55 : 1,
        paddingVertical: 10,
        borderBottomColor: tokens.border,
        borderBottomWidth: 1,
        flexDirection: "row",
        alignItems: "center",
        gap: 10,
      }}
    >
      <View
        style={{
          width: 8,
          height: 8,
          borderRadius: 4,
          backgroundColor: session.isFocusedOnMac ? accent : tokens.textFaint,
        }}
      />
      <View style={{ flex: 1, minWidth: 0 }}>
        <Text style={{ color: tokens.text, fontSize: 15 }} numberOfLines={1}>
          {sessionTitle(session)}
        </Text>
        {subtitle ? (
          <View
            style={{
              flexDirection: "row",
              alignItems: "center",
              gap: 4,
              minHeight: SUBTITLE_LINE,
            }}
          >
            {subtitle.kind === "agent" ? <AgentMark kind={subtitle.agent} /> : null}
            <Text
              style={{
                color: tokens.textMuted,
                fontSize: 12,
                lineHeight: SUBTITLE_LINE,
                flexShrink: 1,
              }}
              numberOfLines={1}
              ellipsizeMode="tail"
            >
              {subtitle.text}
            </Text>
          </View>
        ) : null}
      </View>
      {place ? <Pill tone="muted" text={place} /> : null}
      {showBackend ? <Pill tone="muted" text={backend} /> : null}
      {pill ? <Pill tone={pill.tone} text={pill.label} /> : null}
      {unread ? (
        <View
          style={{
            width: 8,
            height: 8,
            borderRadius: 4,
            backgroundColor: tokens.accents.rose,
          }}
        />
      ) : null}
    </Pressable>
  );
}
