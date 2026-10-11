import type { NamedKey } from "@shellbell/protocol";
import { Pressable, Text, View } from "react-native";
import { tokens } from "../theme/tokens";
import { REPLY_CHIP_HEIGHT } from "./layout";

const CHIPS: { key: string; label: string }[] = [
  { key: "y", label: "y" },
  { key: "n", label: "n" },
  { key: "enter", label: "Enter" },
  { key: "esc", label: "Esc" },
];

/**
 * Spec 10.6: shown when the terminal is waiting on the human (running/blocked). Spec 10.9: the
 * computer's accent tints exactly five surfaces and reply chips are not one of them, so these are
 * neutral tokens, not `accent`.
 *
 * y and n send the single key. The screen cannot say whether a prompt reads one key (an agent's
 * choice menu) or a line (`[y/N]` from a shell script), and a Return sent to a one-key prompt lands
 * on whatever comes next, possibly accepting its default. A lone key is harmless at a line prompt,
 * where Enter is the next chip.
 */
export function ReplyChips({
  onText,
  onKey,
  enterLabel = "Enter",
  disabled = false,
}: {
  onText: (text: string) => void;
  onKey: (key: NamedKey) => void;
  enterLabel?: string;
  disabled?: boolean;
}) {
  const press = (chip: (typeof CHIPS)[number]) => {
    if (chip.key === "y" || chip.key === "n") onText(chip.key);
    else onKey(chip.key as NamedKey);
  };
  return (
    <View style={{ flexDirection: "row", gap: 8 }}>
      {CHIPS.map((chip) => (
        <Pressable
          key={chip.key}
          accessibilityRole="button"
          disabled={disabled}
          accessibilityState={{ disabled }}
          accessibilityLabel={
            chip.key === "y" || chip.key === "n"
              ? `Send ${chip.label}`
              : chip.key === "enter"
                ? enterLabel
                : "Escape"
          }
          accessibilityHint={
            chip.key === "y" || chip.key === "n"
              ? `Sends one key without ${enterLabel}`
              : "Sends this key to the terminal"
          }
          onPress={() => press(chip)}
          style={{
            flex: 1,
            opacity: disabled ? 0.4 : 1,
            minHeight: REPLY_CHIP_HEIGHT,
            borderRadius: tokens.radius.sm,
            borderWidth: 1,
            borderColor: tokens.border,
            backgroundColor: tokens.surface,
            alignItems: "center",
            justifyContent: "center",
          }}
        >
          <Text style={{ color: tokens.text, fontSize: 13, fontWeight: "600" }}>
            {chip.key === "enter" ? enterLabel : chip.label}
          </Text>
        </Pressable>
      ))}
    </View>
  );
}
