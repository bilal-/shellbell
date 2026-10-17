import { type TerminalSetup, terminalNeedsAttention, terminalSetupText } from "@shellbell/protocol";
import { Text, View } from "react-native";
import { tokens } from "../theme/tokens";

/**
 * One line per terminal that needs a step on the computer, such as iTerm2 waiting for approval.
 * Terminals that are absent or closed are not problems and stay quiet; working ones are untouched.
 */
export function TerminalSetupNotice({ setup }: { setup?: readonly TerminalSetup[] }) {
  const needing = (setup ?? []).filter(terminalNeedsAttention);
  if (needing.length === 0) return null;
  return (
    <View
      accessibilityRole="summary"
      style={{
        backgroundColor: tokens.surface,
        borderBottomColor: tokens.border,
        borderBottomWidth: 1,
        paddingHorizontal: 16,
        paddingVertical: 10,
        gap: 6,
      }}
    >
      {needing.map((terminal) => {
        const { status, fix } = terminalSetupText(terminal, "phone");
        return (
          <View key={terminal.name} accessible accessibilityLabel={`${status} ${fix ?? ""}`}>
            <Text style={{ color: tokens.text, fontSize: 14 }}>{status}</Text>
            {fix ? <Text style={{ color: tokens.textMuted, fontSize: 13 }}>{fix}</Text> : null}
          </View>
        );
      })}
    </View>
  );
}
