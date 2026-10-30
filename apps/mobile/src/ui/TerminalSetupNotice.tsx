import {
  noUsableMacTerminal,
  noUsableMacTerminalText,
  type TerminalSetup,
  terminalNeedsAttention,
  terminalSetupText,
} from "@shellbell/protocol";
import { Text, View } from "react-native";
import { tokens } from "../theme/tokens";

/**
 * One line per terminal that needs a step on the computer, such as iTerm2 waiting for approval.
 * Terminals that are absent or closed are not problems and stay quiet, unless a Mac has none of
 * them at all; working ones are untouched.
 */
export function TerminalSetupNotice({ setup }: { setup?: readonly TerminalSetup[] }) {
  const needing = (setup ?? []).filter(terminalNeedsAttention);
  const lines = noUsableMacTerminal(setup ?? [])
    ? [{ key: "none", ...noUsableMacTerminalText("phone") }]
    : needing.map((terminal) => ({
        key: terminal.name,
        ...terminalSetupText(terminal, "phone"),
      }));
  if (lines.length === 0) return null;
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
      {lines.map(({ key, status, fix }) => {
        return (
          <View key={key} accessible accessibilityLabel={`${status} ${fix ?? ""}`}>
            <Text style={{ color: tokens.text, fontSize: 14 }}>{status}</Text>
            {fix ? <Text style={{ color: tokens.textMuted, fontSize: 13 }}>{fix}</Text> : null}
          </View>
        );
      })}
    </View>
  );
}
