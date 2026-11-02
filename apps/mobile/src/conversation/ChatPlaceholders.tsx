import { Pressable, Text, View } from "react-native";
import { agentName } from "../input/agentPrompt";
import { tokens } from "../theme/tokens";

/** Chat before the computer's first page: never the terminal, never a timer. */
export function ChatOpening({ agent }: { agent: string | undefined }) {
  const name = agentName(agent);
  return (
    <View testID="chat-opening" style={{ flex: 1, backgroundColor: tokens.bg, padding: 16 }}>
      <Text accessibilityLiveRegion="polite" style={{ color: tokens.textMuted, fontSize: 14 }}>
        {name ? `Opening ${name}’s chat…` : "Opening the chat…"}
      </Text>
    </View>
  );
}

/** One line over Chat saying it can't update now, with the way to the terminal. */
export function ChatUnavailableBanner({
  text = "Chat isn’t available right now.",
  onShowTerminal,
}: {
  text?: string;
  onShowTerminal: () => void;
}) {
  return (
    <View
      testID="chat-unavailable"
      style={{
        flexDirection: "row",
        alignItems: "center",
        gap: 12,
        paddingLeft: 12,
        backgroundColor: tokens.surface2,
      }}
    >
      <Text
        accessibilityRole="text"
        accessibilityLiveRegion="polite"
        numberOfLines={1}
        style={{ flex: 1, color: tokens.text, fontSize: 14 }}
      >
        {text}
      </Text>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel="Show terminal"
        onPress={onShowTerminal}
        style={({ pressed }) => ({
          minHeight: 44,
          paddingHorizontal: 12,
          justifyContent: "center",
          opacity: pressed ? 0.6 : 1,
        })}
      >
        <Text style={{ color: tokens.text, fontSize: 14, fontWeight: "600" }}>Show terminal</Text>
      </Pressable>
    </View>
  );
}

/** A short line at the top of Chat when the session's chat was replaced. */
export function ChatNotice({ text }: { text: string }) {
  return (
    <Text
      testID="chat-notice"
      accessibilityLiveRegion="polite"
      style={{
        color: tokens.textMuted,
        fontSize: 13,
        textAlign: "center",
        paddingVertical: 6,
        borderBottomWidth: 1,
        borderBottomColor: tokens.border,
      }}
    >
      {text}
    </Text>
  );
}

/** Over earlier rows kept, dimmed and read-only, while the computer opens the chat again. */
export function ChatChecking() {
  return (
    <Text
      testID="chat-checking"
      accessibilityLiveRegion="polite"
      style={{ color: tokens.textMuted, fontSize: 13, paddingHorizontal: 14, paddingVertical: 6 }}
    >
      Checking…
    </Text>
  );
}

/** Pinned at the bottom of Chat after the agent quit to the shell. Its rows stay above. */
export function ChatExitedCard({
  agent,
  onShowTerminal,
}: {
  agent: string | undefined;
  onShowTerminal: () => void;
}) {
  const name = agentName(agent);
  return (
    <View
      testID="chat-exited"
      accessibilityLiveRegion="polite"
      style={{
        flexDirection: "row",
        alignItems: "center",
        gap: 12,
        paddingLeft: 14,
        borderTopWidth: 1,
        borderTopColor: tokens.border,
        backgroundColor: tokens.surface,
      }}
    >
      <Text style={{ flex: 1, color: tokens.text, fontSize: 14, fontWeight: "600" }}>
        {name ? `${name} exited` : "The agent exited"}
      </Text>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel="Show terminal"
        onPress={onShowTerminal}
        style={({ pressed }) => ({
          minHeight: 44,
          paddingHorizontal: 12,
          justifyContent: "center",
          opacity: pressed ? 0.6 : 1,
        })}
      >
        <Text style={{ color: tokens.text, fontSize: 14, fontWeight: "600" }}>Show terminal</Text>
      </Pressable>
    </View>
  );
}
