import type { HostPlatform } from "@shellbell/protocol";
import { QUICK_KEYS } from "./keys";

export function keyPresentation(platform?: HostPlatform) {
  const mac = platform === "darwin";
  const host = { darwin: "macOS", linux: "Linux", win32: "Windows", unknown: "OS not reported" }[
    platform ?? "unknown"
  ];
  const names: Record<string, string> = {
    esc: "Escape",
    tab: "Tab",
    backspace: "Backspace",
    enter: mac ? "Return" : "Enter",
    up: "Arrow up",
    down: "Arrow down",
    left: "Arrow left",
    right: "Arrow right",
  };
  return {
    hostLabel: `Shellbell host: ${host}`,
    guide: `${mac ? "⌃ Control, ⌘ Command, ⌥ Option. Command desktop shortcuts are not sent by Shellbell. " : "These are terminal keys, not desktop shortcuts. "}Tap Shift, Ctrl or Alt, then a key or a letter button. Modifiers clear after one accepted key. Shift + Left works with terminal selection prompts; Shift + Tab moves backward through choices. Alt sends terminal input, not a desktop shortcut. Use your phone keyboard's Shift for text in the composer. Ctrl+C commonly interrupts, not copy; behavior depends on the running program. This host is the computer running Shellbell, not necessarily the environment inside the terminal.`,
    keys: QUICK_KEYS.map((key) => {
      const control = key.key.startsWith("ctrl-") ? key.key.slice(5).toUpperCase() : null;
      return {
        key: key.key,
        label: control
          ? `${mac ? "⌃" : "Ctrl+"}${control}`
          : key.key === "enter"
            ? mac
              ? "Return"
              : "Enter"
            : key.key === "backspace"
              ? mac
                ? "⌫"
                : "Backspace"
              : key.label,
        accessibilityLabel: control ? `Control ${control}` : (names[key.key] ?? key.label),
      };
    }),
  };
}
