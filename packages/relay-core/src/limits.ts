import { FRAME_LIMITS } from "@shellbell/protocol";
// Persisted window validation and atomic admission must use the same limit.
// Changing it also requires reviewing existing storage-schema constraints.
export const MAX_PAIRING_ADMISSIONS = 5;
// Includes unauthenticated sockets; challenges and serialized handlers also use memory.
export const MAX_COMPUTER_CONNECTIONS = 128;

export type SocketState = "unauth" | "agent" | "phone" | "pairing";

export function frameLimitFor(state: SocketState, isCtrl: boolean): number {
  if (state === "unauth") return FRAME_LIMITS.unauth;
  if (isCtrl || state === "pairing") return FRAME_LIMITS.ctrl;
  return state === "agent" ? FRAME_LIMITS.e2eFromAgent : FRAME_LIMITS.e2eFromPhone;
}

export class TokenBucket {
  private tokens: number;
  private last: number | null = null;

  constructor(
    private readonly rate = 60,
    private readonly burst = 200,
  ) {
    this.tokens = burst;
  }

  take(now: number): boolean {
    if (this.last !== null && now > this.last) {
      this.tokens = Math.min(this.burst, this.tokens + ((now - this.last) / 1000) * this.rate);
    }
    if (this.last === null || now > this.last) this.last = now;
    if (this.tokens < 1) return false;
    this.tokens -= 1;
    return true;
  }
}
