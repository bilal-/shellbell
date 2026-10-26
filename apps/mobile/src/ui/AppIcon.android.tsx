import { Text } from "react-native";
import { FONT, tokens } from "../theme/tokens";

/**
 * On Android, icons are Material Design glyphs from the JetBrains Mono Nerd Font the app already
 * ships, so it needn't also carry expo-symbols' 1 MB Material Symbols font. iOS keeps SF Symbols
 * (`AppIcon.tsx`); both name the same icons.
 */
const glyphs = {
  settings: "\u{F0493}",
  more: "\u{F01D8}",
  return: "\u{F0311}",
  backspace: "\u{F006E}",
  up: "\u{F005D}",
  down: "\u{F0045}",
  left: "\u{F004D}",
  right: "\u{F0054}",
  plus: "\u{F0415}",
  minus: "\u{F0374}",
  chevronDown: "\u{F0140}",
  chevronUp: "\u{F0143}",
  check: "\u{F012C}",
  close: "\u{F0156}",
  lock: "\u{F033E}",
  history: "\u{F02DA}",
  keyboard: "\u{F030C}",
  faceid: "\u{F0C7B}",
  fingerprint: "\u{F0237}",
  agent: "\u{F0674}",
} as const;

export type AppIconName = keyof typeof glyphs;

/** Decorative: the containing control owns its accessible name. */
export function AppIcon({
  name,
  size = 20,
  color = tokens.text,
}: {
  name: AppIconName;
  size?: number;
  color?: string;
}) {
  return (
    <Text
      accessible={false}
      importantForAccessibility="no"
      allowFontScaling={false}
      style={{
        fontFamily: FONT.regular,
        fontSize: size,
        lineHeight: size,
        width: size,
        height: size,
        textAlign: "center",
        includeFontPadding: false,
        color,
      }}
    >
      {glyphs[name]}
    </Text>
  );
}
