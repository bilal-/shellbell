import type { NamedKey } from "@shellbell/protocol";
import { Pressable, Text, View } from "react-native";
import { tokens } from "../theme/tokens";
import { AppIcon } from "../ui/AppIcon";
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
 */
export function ReplyChips({
  onLine,
  onKey,
  enterLabel = "Enter",
  disabled = false,
}: {
  onLine: (line: string) => void;
  onKey: (key: NamedKey) => void;
  enterLabel?: string;
  disabled?: boolean;
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
          accessibilityRole="button"
          disabled={disabled}
          accessibilityState={{ disabled }}
          accessibilityLabel={
            chip.key === "y" || chip.key === "n"
              ? `Send ${chip.label} and ${enterLabel}`
              : chip.key === "enter"
                ? enterLabel
                : "Escape"
          }
          onPress={() => press(chip)}
          style={{
            flex: 1,
            opacity: disabled ? 0.4 : 1,
            minHeight: REPLY_CHIP_HEIGHT,
            flexDirection: "row",
            gap: 5,
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
          {chip.key === "y" || chip.key === "n" ? <AppIcon name="return" size={16} /> : null}
        </Pressable>
      ))}
    </View>
  );
}
