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
export function ChatUnavailableBanner({ onShowTerminal }: { onShowTerminal: () => void }) {
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
        Chat isn’t available right now.
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
