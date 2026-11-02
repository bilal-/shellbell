import type { SessionInfoLoose } from "@shellbell/protocol";
import { Pressable, Text, View } from "react-native";
import { AgentMark } from "../agents/AgentMark";
import { tokens } from "../theme/tokens";
import {
  abbreviateHome,
  sessionAccessibilityLabel,
  sessionSubtitle,
  sessionTitle,
} from "../util/session-label";
import { statePill } from "../util/session-state";
import type { SessionType } from "../util/session-types";
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
  accent,
  unread,
  onPress,
  status,
  place,
  dim = false,
  hint = "Open terminal",
  types,
  filterable,
  onFilter,
  onDetails,
}: {
  session: SessionInfoLoose;
  /** The terminal's display name, for the row's spoken label. */
  backend: string;
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
  /** Where the session runs and what runs in it, shown as pills that filter the list. */
  types?: { terminal: SessionType; runs: SessionType | null };
  /** Whether a pill's type is one the list's filter offers; the others are labels only. */
  filterable?: (type: SessionType) => boolean;
  onFilter?: (type: SessionType) => void;
  /** Opens the session's details sheet from the (i) at the end of the row. */
  onDetails?: () => void;
}) {
  const pill = status ?? statePill(session.state);
  const full = sessionSubtitle(session);
  // The agent's pill names it already; the line under the title keeps the task, or the folder.
  const subtitle =
    full?.kind === "agent" && types?.runs?.kind === "agent"
      ? (() => {
          const text =
            session.agent?.task?.trim() || (session.cwd ? abbreviateHome(session.cwd) : "");
          return text ? { ...full, text } : undefined;
        })()
      : full;
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
        {types ? (
          <View style={{ flexDirection: "row", gap: 4, marginTop: 4 }}>
            {[types.terminal, types.runs].map((type) => {
              if (!type) return null;
              const pill = (
                <Pill
                  color={type.kind === "terminal" ? tokens.textMuted : tokens.text}
                  text={type.label}
                />
              );
              return onFilter && filterable?.(type) !== false ? (
                <Pressable
                  key={`${type.kind}:${type.value}`}
                  accessibilityRole="button"
                  accessibilityLabel={`Show only ${type.label}`}
                  onPress={() => onFilter(type)}
                  hitSlop={{ top: 8, bottom: 8, left: 2, right: 2 }}
                >
                  {pill}
                </Pressable>
              ) : (
                <View key={`${type.kind}:${type.value}`}>{pill}</View>
              );
            })}
          </View>
        ) : null}
      </View>
      {place ? <Pill tone="muted" text={place} /> : null}
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
      {onDetails ? (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={`Details for ${sessionTitle(session)}`}
          onPress={onDetails}
          hitSlop={8}
          style={{ minWidth: 32, minHeight: 32, alignItems: "center", justifyContent: "center" }}
        >
          <AppIcon name="info" size={18} color={tokens.textMuted} />
        </Pressable>
      ) : null}
    </Pressable>
  );
}
