import { Pressable, ScrollView, Text, View } from "react-native";
import { FONT, tokens } from "../theme/tokens";
import type { MenuOption } from "./agentPrompt";
import { WARNING_KEY_COLOR } from "./QuickKeys";

export const WAITING_CHIP_HEIGHT = 48;

/** What a chip sends: a typed character, or Return or Escape. */
export type WaitingReply = { text: string } | { key: "enter" | "esc" };

interface Chip {
  id: string;
  label: string;
  badge?: string;
  accessibilityLabel: string;
  accessibilityHint: string;
  reply: WaitingReply;
  warning?: boolean;
}

/**
 * Shown in place of the keys row while an agent is blocked on the person: who is waiting, one line
 * of what it asks, and large replies. A numbered menu read from the screen gets one chip per choice
 * (tapping types its digit); otherwise Yes, No, Enter and Esc. Esc is always there.
 */
export function WaitingStrip({
  label,
  question,
  options,
  accent,
  enterLabel,
  compact,
  chipHeight = WAITING_CHIP_HEIGHT,
  disabled,
  onReply,
}: {
  label: string;
  question: string | null;
  options: MenuOption[] | null;
  accent: string;
  enterLabel: string;
  /** A short pane keeps only the replies. */
  compact: boolean;
  chipHeight?: number;
  disabled: boolean;
  onReply: (reply: WaitingReply) => void;
}) {
  const esc: Chip = {
    id: "esc",
    label: "Esc",
    accessibilityLabel: "Escape",
    accessibilityHint: "Sends Escape to the terminal",
    reply: { key: "esc" },
    warning: true,
  };
  const chips: Chip[] = options
    ? [
        ...options.map(
          (option): Chip => ({
            id: `option:${option.digit}`,
            label: option.label,
            badge: option.digit,
            accessibilityLabel: `Choose ${option.digit}, ${option.label}`,
            accessibilityHint: `Sends ${option.digit} to the terminal`,
            reply: { text: option.digit },
          }),
        ),
        esc,
      ]
    : [
        {
          id: "yes",
          label: "Yes",
          accessibilityLabel: "Yes",
          accessibilityHint: `Sends y without ${enterLabel}`,
          reply: { text: "y" },
        },
        {
          id: "no",
          label: "No",
          accessibilityLabel: "No",
          accessibilityHint: `Sends n without ${enterLabel}`,
          reply: { text: "n" },
        },
        {
          id: "enter",
          label: enterLabel,
          accessibilityLabel: enterLabel,
          accessibilityHint: "Sends this key to the terminal",
          reply: { key: "enter" },
        },
        esc,
      ];
  const chip = (c: Chip) => (
    <Pressable
      key={c.id}
      accessibilityRole="button"
      accessibilityLabel={c.accessibilityLabel}
      accessibilityHint={c.accessibilityHint}
      disabled={disabled}
      accessibilityState={{ disabled }}
      onPress={() => onReply(c.reply)}
      style={{
        flex: options ? undefined : 1,
        minWidth: options ? 64 : undefined,
        maxWidth: options && c.badge ? 232 : undefined,
        minHeight: chipHeight,
        paddingHorizontal: 12,
        flexDirection: "row",
        alignItems: "center",
        justifyContent: "center",
        gap: 8,
        borderRadius: tokens.radius.sm,
        borderWidth: 1,
        borderColor: c.warning ? `${WARNING_KEY_COLOR}59` : `${accent}59`,
        backgroundColor: tokens.surface2,
        opacity: disabled ? 0.4 : 1,
      }}
    >
      {c.badge ? (
        <View
          style={{
            width: 22,
            height: 22,
            borderRadius: 11,
            backgroundColor: accent,
            alignItems: "center",
            justifyContent: "center",
          }}
        >
          <Text style={{ color: tokens.bg, fontSize: 12, fontWeight: "700" }}>{c.badge}</Text>
        </View>
      ) : null}
      <Text
        numberOfLines={2}
        style={{
          flexShrink: 1,
          color: c.warning ? WARNING_KEY_COLOR : tokens.text,
          fontSize: 14,
          fontWeight: "600",
        }}
      >
        {c.label}
      </Text>
    </Pressable>
  );
  return (
    <View
      style={{
        gap: compact ? 0 : 6,
        padding: compact ? 0 : 8,
        borderRadius: tokens.radius.md,
        borderWidth: compact ? 0 : 1,
        borderColor: `${accent}4D`,
        backgroundColor: compact ? undefined : `${accent}14`,
      }}
    >
      {compact ? null : (
        <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
          <View
            accessible={false}
            importantForAccessibility="no"
            style={{ width: 8, height: 8, borderRadius: 4, backgroundColor: accent }}
          />
          <Text
            accessibilityRole="header"
            accessibilityLiveRegion="polite"
            style={{ color: accent, fontSize: 13, fontWeight: "700" }}
          >
            {label}
          </Text>
        </View>
      )}
      {question && !compact ? (
        <Text
          numberOfLines={1}
          style={{ color: tokens.textMuted, fontFamily: FONT.regular, fontSize: 12 }}
        >
          {question}
        </Text>
      ) : null}
      {options ? (
        <ScrollView
          horizontal
          keyboardShouldPersistTaps="always"
          keyboardDismissMode="none"
          showsHorizontalScrollIndicator={false}
          contentContainerStyle={{ gap: 8 }}
        >
          {chips.map(chip)}
        </ScrollView>
      ) : (
        <View style={{ flexDirection: "row", gap: 8 }}>{chips.map(chip)}</View>
      )}
    </View>
  );
}
