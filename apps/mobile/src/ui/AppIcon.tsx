import { SymbolView, type SymbolViewProps } from "expo-symbols";
import { tokens } from "../theme/tokens";

const symbols = {
  settings: { ios: "gearshape", android: "settings" },
  more: { ios: "ellipsis", android: "more_horiz" },
  return: { ios: "return", android: "keyboard_return" },
  backspace: { ios: "delete.left", android: "backspace" },
  up: { ios: "arrow.up", android: "arrow_upward" },
  down: { ios: "arrow.down", android: "arrow_downward" },
  left: { ios: "arrow.left", android: "arrow_back" },
  right: { ios: "arrow.right", android: "arrow_forward" },
  plus: { ios: "plus", android: "add" },
  minus: { ios: "minus", android: "remove" },
  check: { ios: "checkmark", android: "check" },
  close: { ios: "xmark", android: "close" },
  lock: { ios: "lock.fill", android: "lock" },
  history: { ios: "clock.arrow.circlepath", android: "history" },
  faceid: { ios: "faceid", android: "face" },
  fingerprint: { ios: "touchid", android: "fingerprint" },
  /** A coding agent, such as Claude Code or Codex, in a session row. */
  agent: { ios: "sparkles", android: "auto_awesome" },
} as const satisfies Record<string, SymbolViewProps["name"]>;

export type AppIconName = keyof typeof symbols;

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
    <SymbolView
      name={symbols[name]}
      type="monochrome"
      tintColor={color}
      size={size}
      accessible={false}
      importantForAccessibility="no"
    />
  );
}
