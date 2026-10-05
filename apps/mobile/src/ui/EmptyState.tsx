import { Pressable, Text, View } from "react-native";
import { tokens } from "../theme/tokens";

interface EmptyStateProps {
  text: string;
  action?: { label: string; onPress: () => void };
}

/** One sentence, one action (spec 10.9). */
export function EmptyState({ text, action }: EmptyStateProps) {
  return (
    <View
      style={{
        flex: 1,
        alignItems: "center",
        justifyContent: "center",
        gap: 16,
        padding: 24,
        backgroundColor: tokens.bg,
      }}
    >
      <Text style={{ color: tokens.textMuted, fontSize: 15, textAlign: "center" }}>{text}</Text>
      {action ? (
        <Pressable
          onPress={action.onPress}
          style={{
            backgroundColor: tokens.surface2,
            borderColor: tokens.border,
            borderWidth: 1,
            borderRadius: tokens.radius.md,
            paddingHorizontal: 16,
            paddingVertical: 10,
          }}
        >
          <Text style={{ color: tokens.text, fontSize: 15 }}>{action.label}</Text>
        </Pressable>
      ) : null}
    </View>
  );
}
