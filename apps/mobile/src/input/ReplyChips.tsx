import type { NamedKey } from "@shellbell/protocol";
import { Pressable, Text, View } from "react-native";
import { tokens } from "../theme/tokens";

const CHIPS: { key: string; label: string }[] = [
  { key: "y", label: "y ⏎" },
  { key: "n", label: "n ⏎" },
  { key: "enter", label: "⏎" },
  { key: "esc", label: "Esc" },
];

/**
 * Spec 10.6: shown when the terminal is waiting on the human (running/blocked). Spec 10.9: the
 * computer's accent tints exactly five surfaces and reply chips are not one of them, so these are
 * neutral tokens, not `accent`.
 */
export function ReplyChips({
  onLine,
  onKey,
}: {
  onLine: (line: string) => void;
  onKey: (key: NamedKey) => void;
}) {
  const press = (chip: (typeof CHIPS)[number]) => {
    if (chip.key === "y" || chip.key === "n") onLine(chip.key);
    else onKey(chip.key as NamedKey);
  };
  return (
    <View style={{ flexDirection: "row", gap: 8 }}>
      {CHIPS.map((chip) => (
        <Pressable
          key={chip.key}
          accessibilityLabel={chip.label}
          onPress={() => press(chip)}
          style={{
            flex: 1,
            height: 32,
            borderRadius: tokens.radius.sm,
            borderWidth: 1,
            borderColor: tokens.border,
            backgroundColor: tokens.surface,
            alignItems: "center",
            justifyContent: "center",
          }}
        >
          <Text style={{ color: tokens.text, fontSize: 13, fontWeight: "600" }}>{chip.label}</Text>
        </Pressable>
      ))}
    </View>
  );
}
