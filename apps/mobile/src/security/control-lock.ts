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

/**
 * Page requests count as control too: a request can change something on the computer, and must
 * not queue up and run unseen later. `web.reset`, `web.credit` and `web.view {open: false}` only
 * acknowledge or reduce, so they always get through; `web.view {open: true}` keeps a page's
 * server running, so it doesn't.
 */
export function isControlMessage(
  msg: Pick<InnerMessageLoose, "type"> & { open?: unknown },
): boolean {
  if (msg.type === "web.view") return msg.open === true;
  return (
    msg.type.startsWith("input.") ||
    msg.type === "session.create" ||
    msg.type === "session.focus" ||
    msg.type === "web.open" ||
    msg.type === "web.data" ||
    msg.type === "web.end"
  );
}
