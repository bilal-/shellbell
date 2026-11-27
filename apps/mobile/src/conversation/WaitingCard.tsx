import type { PromptDialog } from "@shellbell/protocol";
import { Pressable, ScrollView, Text, View } from "react-native";
import { agentName } from "../input/agentPrompt";
import { FONT, tokens } from "../theme/tokens";
import { BreathingDot } from "./motion";

/** Amber, for "waiting for you", in the bar and this card alike. */
export const WAITING_COLOR = tokens.terminal16[3];

/** At most this tall, the dialog and its choices; the rest scrolls. */
const DIALOG_MAX_HEIGHT = 320;

/**
 * Pinned at the bottom of Chat while the agent waits for an answer. When Chat can read the whole
 * dialog (the command, file or question, and every choice), each choice is a button; the computer
 * types it only while that very dialog is still on its screen. Otherwise only Esc and the way to
 * the terminal.
 */
export function WaitingCard({
  agent,
  question,
  dialog = null,
  answerable = false,
  onAnswer,
  onEscape,
  onShowTerminal,
}: {
  agent: string | undefined;
  question: string | null;
  /** The whole dialog, when Chat can answer it. */
  dialog?: Pick<PromptDialog, "body" | "options" | "highlighted"> | null;
  /** The choices take a tap: shown a moment already, and not answered from here yet. */
  answerable?: boolean;
  onAnswer?: (choice: string) => void;
  onEscape: () => void;
  onShowTerminal: () => void;
}) {
  // On a dialog Chat answers, Esc waits like the choices: a tap meant for the card before
  // can't cancel a new one.
  const escapeReady = dialog === null || answerable;
  const name = agentName(agent);
  const title = name ? `${name} is waiting for you` : "Waiting for you";
  const button = (
    label: string,
    accessibilityLabel: string,
    onPress: () => void,
    enabled = true,
  ) => (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel}
      accessibilityState={{ disabled: !enabled }}
      disabled={!enabled}
      onPress={onPress}
      style={({ pressed }) => ({
        minHeight: 44,
        paddingHorizontal: 14,
        borderRadius: tokens.radius.sm,
        borderWidth: 1,
        borderColor: tokens.border,
        backgroundColor: tokens.surface2,
        justifyContent: "center",
        opacity: !enabled ? 0.45 : pressed ? 0.6 : 1,
      })}
    >
      <Text style={{ color: tokens.text, fontSize: 14, fontWeight: "600" }}>{label}</Text>
    </Pressable>
  );
  return (
    <View
      testID="waiting-card"
      accessibilityLiveRegion="polite"
      style={{
        gap: 8,
        paddingHorizontal: 14,
        paddingVertical: 10,
        borderTopWidth: 1,
        borderTopColor: tokens.border,
        backgroundColor: tokens.surface,
      }}
    >
      <View style={{ flexDirection: "row", alignItems: "center", gap: 10 }}>
        <BreathingDot color={WAITING_COLOR} />
        <Text
          accessibilityRole="header"
          style={{ color: WAITING_COLOR, fontSize: 14, fontWeight: "600" }}
        >
          {title}
        </Text>
      </View>
      {dialog ? (
        // The dialog and its choices scroll together, so Esc and Show terminal stay in reach.
        <ScrollView
          testID="waiting-dialog"
          style={{ maxHeight: DIALOG_MAX_HEIGHT }}
          nestedScrollEnabled
          contentContainerStyle={{ gap: 8 }}
        >
          {dialog.body.length ? (
            <Text selectable style={{ color: tokens.text, fontSize: 13, fontFamily: FONT.regular }}>
              {dialog.body.join("\n")}
            </Text>
          ) : null}
          <View style={{ gap: 6 }}>
            {dialog.options.map((option, index) => (
              <Pressable
                key={option.digit}
                testID={`answer-${option.digit}`}
                accessibilityRole="button"
                accessibilityLabel={`${option.digit}. ${option.label}`}
                accessibilityState={{ disabled: !answerable }}
                disabled={!answerable}
                onPress={() => onAnswer?.(option.digit)}
                style={({ pressed }) => ({
                  minHeight: 44,
                  paddingHorizontal: 12,
                  paddingVertical: 8,
                  borderRadius: tokens.radius.sm,
                  borderWidth: 1,
                  borderColor: index === dialog.highlighted ? WAITING_COLOR : tokens.border,
                  backgroundColor: tokens.surface2,
                  justifyContent: "center",
                  opacity: !answerable ? 0.45 : pressed ? 0.6 : 1,
                })}
              >
                <Text style={{ color: tokens.text, fontSize: 14 }}>
                  <Text style={{ color: tokens.textMuted }}>{`${option.digit}  `}</Text>
                  {option.label}
                </Text>
              </Pressable>
            ))}
          </View>
        </ScrollView>
      ) : question ? (
        <Text numberOfLines={3} style={{ color: tokens.text, fontSize: 14 }}>
          {question}
        </Text>
      ) : null}
      <View style={{ flexDirection: "row", gap: 8 }}>
        {button("Esc", "Press Esc", onEscape, escapeReady)}
        {button("Show terminal", "Show terminal", onShowTerminal)}
      </View>
    </View>
  );
}
