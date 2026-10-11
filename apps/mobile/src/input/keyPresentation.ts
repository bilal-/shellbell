import type { HostPlatform } from "@shellbell/protocol";
import { type QuickKey, quickKeys, WARNING_KEYS } from "./keys";

export interface PresentedKey {
  /** Stable React key and test handle: the named key, or `text:` and the character. */
  id: string;
  key?: QuickKey["key"];
  text?: string;
  label: string;
  accessibilityLabel: string;
  /** Esc and ^C stop or back out of what is running. */
  warning: boolean;
}

/** `agent`: the session runs a coding agent, which reorders the row for its menus. */
export function keyPresentation(platform?: HostPlatform, agent = false) {
  const mac = platform === "darwin";
  // One name on every host: the Send button, the keys row and spoken labels all say Enter.
  const enterLabel = "Enter";
  const host = { darwin: "macOS", linux: "Linux", win32: "Windows", unknown: "OS not reported" }[
    platform ?? "unknown"
  ];
  const names: Record<string, string> = {
    esc: "Escape",
    tab: "Tab",
    backspace: "Backspace",
    enter: enterLabel,
    up: "Arrow up",
    down: "Arrow down",
    left: "Arrow left",
    right: "Arrow right",
    "shift-tab": agent ? "Shift Tab, switch mode" : "Shift Tab",
  };
  const row = quickKeys(agent);
  return {
    enterLabel,
    hostLabel: `Shellbell host: ${host}`,
    guide: `${mac ? "⌃ Control, ⌘ Command, ⌥ Option. Command desktop shortcuts are not sent by Shellbell. " : "These are terminal keys, not desktop shortcuts. "}Tap Shift, Ctrl or Alt, then a key or a letter button. Modifiers clear after one accepted key. Shift + Left works with terminal selection prompts; Shift + Tab moves backward through choices. Alt sends terminal input, not a desktop shortcut. Use your phone keyboard's Shift for text in the command bar. Ctrl+C commonly interrupts, not copy; behavior depends on the running program. This host is the computer running Shellbell, not necessarily the environment inside the terminal.`,
    primary: row.primary,
    keys: row.keys.map((key): PresentedKey => {
      if (key.text !== undefined)
        return {
          id: `text:${key.text}`,
          text: key.text,
          label: key.label,
          accessibilityLabel: `Send ${key.text}`,
          warning: false,
        };
      const control = key.key.startsWith("ctrl-") ? key.key.slice(5).toUpperCase() : null;
      return {
        id: key.key,
        key: key.key,
        warning: WARNING_KEYS.has(key.key),
        label: control
          ? `${mac ? "⌃" : "Ctrl+"}${control}`
          : key.key === "enter"
            ? enterLabel
            : key.label,
        accessibilityLabel: control ? `Control ${control}` : (names[key.key] ?? key.label),
      };
    }),
  };
}
