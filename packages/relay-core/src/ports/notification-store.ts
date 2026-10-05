import type { CtrlMessageOf } from "@shellbell/protocol";
import type { Claim, NotifyMessage } from "../notifications/models.js";
import type { SendOutcome } from "../notifications/provider.js";

/** Every mutation atomically checks and applies shared core policy. No provider I/O. */
export interface NotificationStore {
  register(
    phoneFp: string,
    message: CtrlMessageOf<"push-token">,
    generation: string,
  ): Promise<void>;
  enqueue(message: NotifyMessage, now: number): Promise<void>;
  cancelPhone(phoneFp: string): Promise<void>;
  claimSends(now: number, limit: number): Promise<readonly Claim[]>;
  /** Recheck after scheduler/persistence awaits, immediately before provider dispatch. */
  isCurrent(claim: Claim, now: number): Promise<boolean>;
  finishSend(claim: Claim, outcome: SendOutcome, now: number): Promise<void>;
  recover(now: number): Promise<void>;
  nextDeadline(): Promise<number | null>;
}
