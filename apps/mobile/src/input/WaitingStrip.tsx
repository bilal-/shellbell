import { Pressable, ScrollView, Text, View } from "react-native";
import { FONT, tokens } from "../theme/tokens";
import { AppIcon, type AppIconName } from "../ui/AppIcon";
import type { BlockedPrompt, MenuOption } from "./agentPrompt";
import { modifiedKey } from "./modifiers";
import { WARNING_KEY_COLOR } from "./QuickKeys";

export const WAITING_CHIP_HEIGHT = 48;

/** Each tap sends one explicit input; only navigation leaves the suggestions open. */
export type WaitingReply = ({ text: string } | { key: "enter" | "esc" | "up" | "down" }) & {
  keepOpen?: true;
};

interface Chip {
  id: string;
  label: string;
  icon?: AppIconName;
  badge?: string;
  accessibilityLabel: string;
  accessibilityHint: string;
  reply: WaitingReply;
  warning?: boolean;
}

/**
 * Shown in place of the keys row while an agent is blocked on the person: who is waiting, one line
 * of what it asks, and large replies. A numbered menu read from the screen gets one chip per choice
 * (tapping sends its explicit reply key or digit). Only explicit y/n prompts get Yes and No;
 * otherwise navigation keys remain useful even when the screen's prompt cannot be inferred.
 */
export function WaitingStrip({
  label,
  question,
  options,
  yesNo,
  accent,
  enterLabel,
  compact,
  chipHeight = WAITING_CHIP_HEIGHT,
  disabled,
  onReply,
  onDismiss,
}: {
  label: string;
  question: string | null;
  options: MenuOption[] | null;
  yesNo?: BlockedPrompt["yesNo"];
  accent: string;
  enterLabel: string;
  /** A short pane keeps only the replies. */
  compact: boolean;
  chipHeight?: number;
  disabled: boolean;
  onReply: (reply: WaitingReply) => void;
  /** Restore the terminal keys without sending a reply. Available even when offline. */
  onDismiss: () => void;
}) {
  const menu = options !== null && options.length > 0;
  const enter: Chip = {
    id: "enter",
    label: enterLabel,
    accessibilityLabel: enterLabel,
    accessibilityHint: "Sends Enter to the terminal",
    reply: { key: "enter" },
  };
  const esc: Chip = {
    id: "esc",
    label: "Esc",
    accessibilityLabel: "Escape",
    accessibilityHint: "Sends Escape to the terminal",
    reply: { key: "esc" },
    warning: true,
  };
  const chips: Chip[] = menu
    ? [
        ...options.map((option): Chip => {
          const shortcut = option.shortcut ?? option.digit;
          const key = shortcut === "esc" || shortcut === "enter" ? shortcut : null;
          return {
            id: `option:${option.digit}`,
            label: option.label,
            badge: shortcut === "enter" ? "↵" : shortcut === "esc" ? "Esc" : shortcut,
            accessibilityLabel: `Choose ${option.digit}, ${option.label}`,
            accessibilityHint: key
              ? `Sends ${key === "esc" ? "Escape" : enterLabel} to the terminal`
              : `Sends ${shortcut} without ${enterLabel}`,
            reply: key ? { key } : { text: shortcut },
            warning: key === "esc",
          };
        }),
        esc,
      ]
    : yesNo
      ? [
          {
            id: "yes",
            label: "Yes",
            accessibilityLabel: "Yes",
            accessibilityHint: `Sends ${yesNo === "yes/no" ? "yes" : "y"} without ${enterLabel}`,
            reply: { text: yesNo === "yes/no" ? "yes" : "y" },
          },
          {
            id: "no",
            label: "No",
            accessibilityLabel: "No",
            accessibilityHint: `Sends ${yesNo === "yes/no" ? "no" : "n"} without ${enterLabel}`,
            reply: { text: yesNo === "yes/no" ? "no" : "n" },
          },
          esc,
        ]
      : [
          {
            id: "up",
            label: "",
            icon: "up",
            accessibilityLabel: "Arrow up",
            accessibilityHint: "Sends Up to move through the terminal menu",
            reply: { key: "up", keepOpen: true },
          },
          {
            id: "down",
            label: "",
            icon: "down",
            accessibilityLabel: "Arrow down",
            accessibilityHint: "Sends Down to move through the terminal menu",
            reply: { key: "down", keepOpen: true },
          },
          {
            id: "shift-left",
            label: "⇧←",
            accessibilityLabel: "Shift Arrow left",
            accessibilityHint: "Sends Shift and Left to the terminal",
            reply: {
              text: modifiedKey("left", { shift: true, control: false, alt: false })!,
              keepOpen: true,
            },
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
        minWidth: c.badge ? 64 : 44,
        maxWidth: c.badge ? 232 : undefined,
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
            minWidth: 22,
            paddingHorizontal: 4,
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
      {c.icon ? <AppIcon name={c.icon} size={18} color={tokens.text} /> : null}
      {c.label ? (
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
      ) : null}
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
      <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
        <ScrollView
          horizontal
          keyboardShouldPersistTaps="always"
          keyboardDismissMode="none"
          showsHorizontalScrollIndicator={false}
          style={{ flex: 1 }}
          contentContainerStyle={{ gap: 8 }}
        >
          {chips.map(chip)}
        </ScrollView>
        {chip(enter)}
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Show terminal keys"
          accessibilityHint="Dismisses the suggested replies without sending input"
          onPress={onDismiss}
          style={{
            width: 44,
            height: compact ? chipHeight : 44,
            alignItems: "center",
            justifyContent: "center",
          }}
        >
          <AppIcon name="close" size={20} color={tokens.textMuted} />
        </Pressable>
      </View>
    </View>
  );
}
