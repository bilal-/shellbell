import type { InnerMessageLoose } from "@shellbell/protocol";
import { DeliveryUnknownError } from "../net/connection";
import { LOST_INPUT_TOAST } from "../net/toasts";

export interface FireHooks {
  track: (reqId: string) => void;
  untrack: (reqId: string, toast?: string) => void;
}

export interface RequestingConn {
  status: string;
  request: (msg: InnerMessageLoose & { reqId: string }) => Promise<unknown>;
}

/**
 * Task 8 review: `InputBar.fire` used to register `pendingInputs` *before* attempting delivery.
 * When the connection existed but wasn't `"online"` (e.g. mid-reconnect), `request()` rejects
 * synchronously with `DeliveryUnknownError` before ever reaching `ComputerConnection`'s own
 * `pending` map -- so the tracked entry was never cleared by an ack or a close event (orphaned
 * forever, M5) and no lost-input toast ever appeared for a keystroke that plainly never sent.
 *
 * Fixed here by only tracking once the connection is genuinely online, and by *always* cleaning
 * up + toasting on a `DeliveryUnknownError`, regardless of which path produced it (a synchronous
 * offline rejection, or a later mid-flight drop).
 */
export function fireInput(
  conn: RequestingConn,
  msg: InnerMessageLoose & { reqId: string },
  hooks: FireHooks,
): void {
  if (conn.status === "online") hooks.track(msg.reqId);
  conn.request(msg).catch((e: unknown) => {
    hooks.untrack(msg.reqId, e instanceof DeliveryUnknownError ? LOST_INPUT_TOAST : undefined);
  });
}
