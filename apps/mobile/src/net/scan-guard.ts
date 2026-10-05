export interface ScanGuardOptions {
  /** How long a completed attempt (success or otherwise) blocks any further scan. Default 2 s. */
  cooldownMs?: number;
  now?: () => number;
}

export type ScanOutcome = "success" | "cancelled" | "error";

/**
 * Guards a QR camera's scan callback so a confirmed, cancelled, or failed pairing attempt can
 * never auto-retry: each `pairing-request` consumes one of the relay's 5 pairing-window
 * admissions (spec 6.4, `WINDOW_MAX_ADMITTED`), and the camera re-fires the same payload on every
 * frame the code stays in view, so an un-guarded callback burns the whole window in a few frames.
 *
 * Three protections, all pure/deterministic (no React, no timers — `now` is injected):
 * - `canHandle` returns false while an attempt is in flight (`begin()` was called, `end()` wasn't).
 * - `canHandle` returns false for `cooldownMs` after any attempt ends, and forever for the exact
 *   same payload until `rearm()` is called.
 * - After a "cancelled" or "error" outcome, `canHandle` stays false — regardless of the cooldown
 *   elapsing or a different payload appearing — until the user explicitly calls `rearm()` (a
 *   "Scan again" tap). A "success" outcome only starts the cooldown: the screen is expected to
 *   navigate away, so there is nothing left to re-arm.
 */
export class ScanGuard {
  private busy = false;
  private blocked = false;
  private lastPayload: string | null = null;
  private cooldownUntil = 0;
  private readonly cooldownMs: number;
  private readonly now: () => number;

  constructor(opts: ScanGuardOptions = {}) {
    this.cooldownMs = opts.cooldownMs ?? 2000;
    this.now = opts.now ?? (() => Date.now());
  }

  /** Whether a freshly scanned payload should be handled right now. */
  canHandle(payload: string): boolean {
    if (this.busy || this.blocked) return false;
    if (this.now() < this.cooldownUntil) return false;
    if (payload === this.lastPayload) return false;
    return true;
  }

  /** Call once a scan passes `canHandle` and is about to be processed. */
  begin(payload: string): void {
    this.busy = true;
    this.lastPayload = payload;
  }

  /** Call when the in-flight attempt is fully done, with how it ended. */
  end(outcome: ScanOutcome): void {
    this.busy = false;
    this.cooldownUntil = this.now() + this.cooldownMs;
    if (outcome !== "success") this.blocked = true;
  }

  /** The user tapped "Scan again": re-arm the camera callback. */
  rearm(): void {
    this.blocked = false;
    this.lastPayload = null;
    this.cooldownUntil = 0;
  }

  /** Whether the UI should show a "Scan again" prompt instead of live-scanning. */
  get needsRescanTap(): boolean {
    return this.blocked;
  }
}
