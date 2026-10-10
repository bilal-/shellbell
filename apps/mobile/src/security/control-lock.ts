import type { InnerMessageLoose } from "@shellbell/protocol";

/**
 * App Lock enforcement below the UI. The lock screen blocks touches, but deep links, notification
 * routing and diagnostics reach connections without them; every message that can change a
 * terminal is refused here while the app is locked. Viewing traffic keeps flowing so the screen is
 * current the moment the phone unlocks.
 */
let locked = false;

export function setControlLocked(value: boolean): void {
  locked = value;
}

export function controlLocked(): boolean {
  return locked;
}

export function isControlMessage(msg: Pick<InnerMessageLoose, "type">): boolean {
  return (
    msg.type.startsWith("input.") || msg.type === "session.create" || msg.type === "session.focus"
  );
}
