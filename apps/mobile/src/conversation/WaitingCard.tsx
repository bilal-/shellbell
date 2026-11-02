import { Pressable, Text, View } from "react-native";
import { agentName } from "../input/agentPrompt";
import { tokens } from "../theme/tokens";
import { BreathingDot } from "./motion";

/** Amber, for "waiting for you", in the bar and this card alike. */
export const WAITING_COLOR = tokens.terminal16[3];

/**
 * Pinned at the bottom of Chat while the agent waits for an answer. Answers go in the terminal:
 * there are no answer buttons here, only Esc and the way to the terminal.
 */
export function WaitingCard({
  agent,
  question,
  onEscape,
  onShowTerminal,
}: {
  agent: string | undefined;
  question: string | null;
  onEscape: () => void;
  onShowTerminal: () => void;
}) {
  const name = agentName(agent);
  const title = name ? `${name} is waiting for you` : "Waiting for you";
  const button = (label: string, accessibilityLabel: string, onPress: () => void) => (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel}
      onPress={onPress}
      style={({ pressed }) => ({
        minHeight: 44,
        paddingHorizontal: 14,
        borderRadius: tokens.radius.sm,
        borderWidth: 1,
        borderColor: tokens.border,
        backgroundColor: tokens.surface2,
        justifyContent: "center",
        opacity: pressed ? 0.6 : 1,
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
      {question ? (
        <Text numberOfLines={3} style={{ color: tokens.text, fontSize: 14 }}>
          {question}
        </Text>
      ) : null}
      <View style={{ flexDirection: "row", gap: 8 }}>
        {button("Esc", "Press Esc", onEscape)}
        {button("Show terminal", "Show terminal", onShowTerminal)}
      </View>
    </View>
  );
}
