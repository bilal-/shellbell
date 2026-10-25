import { Text, View } from "react-native";
import { tokens } from "../theme/tokens";
import { AppIcon } from "../ui/AppIcon";
import { agentHarness } from "./registry";

/** The agent's mark in its brand colour; the generic agent icon for agents not in the registry. */
export function AgentMark({ kind, size = 14 }: { kind: string | undefined; size?: number }) {
  const harness = agentHarness(kind);
  if (!harness) return <AppIcon name="agent" size={size - 3} color={tokens.textMuted} />;
  return (
    <View
      importantForAccessibility="no-hide-descendants"
      accessibilityElementsHidden
      style={{
        minWidth: size,
        height: size,
        paddingHorizontal: harness.mark.length > 1 ? 2 : 0,
        borderRadius: 4,
        backgroundColor: `${harness.color}26`,
        borderWidth: 1,
        borderColor: `${harness.color}80`,
        alignItems: "center",
        justifyContent: "center",
      }}
    >
      <Text
        style={{
          color: harness.color,
          fontSize: size * 0.62,
          lineHeight: size * 0.8,
          fontWeight: "700",
        }}
      >
        {harness.mark}
      </Text>
    </View>
  );
}
