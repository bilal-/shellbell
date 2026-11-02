import type { InnerMessageLoose } from "@shellbell/protocol";
import { DeliveryUnknownError } from "../net/connection";
import { LOST_INPUT_TOAST } from "../net/toasts";
export const INPUT_DELIVERY_UNKNOWN = "delivery-unknown";
/** Why a send didn't leave the phone, said the same wherever input is sent. */
export const NOT_SENT_PAUSED = "Not sent while the connection is paused. Your draft is still here.";
export const NOT_SENT_OFFLINE =
  "Not sent: your computer isn’t connected. Your draft is still here.";
export type ComposedInputResult = boolean | typeof INPUT_DELIVERY_UNKNOWN;

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
): Promise<unknown> {
  if (conn.status === "online") hooks.track(msg.reqId);
  return conn.request(msg).catch((e: unknown) => {
    hooks.untrack(msg.reqId, e instanceof DeliveryUnknownError ? LOST_INPUT_TOAST : undefined);
    if (e instanceof DeliveryUnknownError) return INPUT_DELIVERY_UNKNOWN;
  });
}

/** How long a composed send waits for its ack before saying the outcome is unknown. */
export const DELIVERY_TIMEOUT_MS = 10_000;

/**
 * Resolves with the outcome, or `INPUT_DELIVERY_UNKNOWN` once `ms` pass without one. The request
 * itself is never cancelled: an ack that arrives later goes to `onLate`, and a retry with the same
 * request ID joins it rather than running the input twice.
 */
export function withDeliveryTimeout<T>(
  pending: Promise<T>,
  onLate: (outcome: T | undefined) => void,
  ms = DELIVERY_TIMEOUT_MS,
): Promise<T | undefined | typeof INPUT_DELIVERY_UNKNOWN> {
  return new Promise((resolve) => {
    let waited = false;
    const timer = setTimeout(() => {
      waited = true;
      resolve(INPUT_DELIVERY_UNKNOWN);
    }, ms);
    const settle = (outcome: T | undefined) => {
      if (waited) onLate(outcome);
      else {
        clearTimeout(timer);
        resolve(outcome);
      }
    };
    pending.then(settle, () => settle(undefined));
  });
}
