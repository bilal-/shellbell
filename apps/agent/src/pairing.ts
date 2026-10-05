import {
  type CtrlMessage,
  type CtrlMessageOf,
  decodeCbor,
  derivePairKey,
  derivePskKey,
  encodeCbor,
  encodeQr,
  fingerprint,
  type Identity,
  MAX_PAIRINGS,
  open,
  pairingAd,
  pairRevocationIdV2,
  parseQr,
  randomBytes,
  seal,
  sha256,
  toBase64Url,
} from "@shellbell/protocol";
import { z } from "zod";
import type { Pairing } from "./config.js";
import type { Logger } from "./log.js";

export interface PairingManagerOptions {
  identity: Identity;
  fp: string;
  computerName: string;
  accent: string;
  relayUrl: string;
  /** Returns whether the message actually reached the relay (false while unauthenticated/offline)
   * -- `openWindow()`/`readvertise()` log this at debug so a dropped `pairing-open` is diagnosable
   * without ever logging the code/gate itself. */
  sendCtrl: (m: CtrlMessage) => boolean;
  savePairing: (p: Pairing) => void;
  confirm: (phoneFp: string, name: string) => Promise<boolean>;
  /** Number of pairings already persisted for this computer; checked against MAX_PAIRINGS. */
  pairingCount: () => number;
  log: Logger;
  now?: () => number;
  windowMs?: number;
  /** How long to wait for a human to answer the confirmation prompt. Default 60 s. */
  confirmTimeoutMs?: number;
  /** Called whenever an open window transitions to closed (expiry, explicit close, success, or 3 bad codes). */
  onClose?: () => void;
}

const Key32 = z
  .instanceof(Uint8Array)
  .refine((b) => b.length === 32, { message: "expected 32 bytes" });

const RequestBody = z.object({
  ed25519Pub: Key32,
  x25519Pub: Key32,
  name: z.string().min(1).max(64),
  platform: z.enum(["ios", "android"]),
});

/** Relay admits at most this many pairing sockets per window (`WINDOW_MAX_ADMITTED`). */
const WINDOW_MAX_REQUESTS = 5;

interface Window {
  code: Uint8Array;
  gate: Uint8Array;
  expiresAt: number;
  failures: number;
  /** pairing-requests seen in this window; mirrors the relay's 5-admission cap. */
  requests: number;
}

interface PendingAttempt {
  window: Window;
  token: object;
}

export class PairingManager {
  private window: Window | null = null;
  /** Exactly one confirmation attempt is admitted for one exact pairing window. */
  private pending: PendingAttempt | null = null;
  private readonly now: () => number;
  private readonly log: Logger;

  constructor(private readonly opts: PairingManagerOptions) {
    this.now = opts.now ?? (() => Date.now());
    this.log = opts.log.child({ unit: "pairing" });
  }

  get isOpen(): boolean {
    return this.window !== null && this.now() < this.window.expiresAt;
  }

  openWindow(): { qrText: string; expiresAt: number } {
    if (this.window) this.closeWindow();
    const code = randomBytes(16);
    const gate = randomBytes(16);
    const expiresAt = this.now() + (this.opts.windowMs ?? 300_000);
    const qrText = encodeQr({
      v: 1,
      r: this.opts.relayUrl,
      c: this.opts.fp,
      e: toBase64Url(this.opts.identity.ed25519.pub),
      n: this.opts.computerName.slice(0, 40),
      p: toBase64Url(code),
      g: toBase64Url(gate),
    });
    // Round-trip validation: throws if relayUrl/computerName/etc. don't satisfy the QR
    // schema (no trailing slash, non-empty name, ...), before anything is sent or any state
    // is mutated. `allowInsecure` here only widens the accepted *scheme* to include ws://;
    // whether ws:// is actually allowed for this relayUrl was already decided upstream (CLI
    // `--relay` / `config set relay --insecure`) before it ever reached this class.
    parseQr(qrText, { allowInsecure: true });
    this.window = { code, gate, expiresAt, failures: 0, requests: 0 };
    // C1/I1: on first run the relay socket has not authenticated yet (this send is dropped), and
    // a mid-window reconnect drops it again -- `readvertise()` is what actually gets the window
    // to the relay in both cases. This send is still worth attempting: it is a no-op cost when it
    // fails, and it means a window opened *while already authenticated* reaches the relay
    // immediately rather than waiting for the next `auth-ok`.
    const sent = this.opts.sendCtrl({ type: "pairing-open", gateHash: sha256(gate), expiresAt });
    this.log.debug(
      sent
        ? "pairing-open sent"
        : "pairing-open not sent yet; will re-advertise once authenticated",
    );
    this.log.info("pairing window opened");
    return { qrText, expiresAt };
  }

  /**
   * Re-sends `pairing-open` for the current window, if any is open and unexpired -- called after
   * every `auth-ok` (C1: first connect; I1: a reconnect mid-window) so the relay's window row
   * always matches what the printed QR promises. No-op when there is no window, or it has already
   * expired (the next `tick()` will close it locally).
   */
  readvertise(): void {
    if (!this.window || this.now() >= this.window.expiresAt) return;
    // The relay deletes its window row when our socket drops and would recreate it with a fresh
    // admission budget; mirror the 5-admission cap here so a reconnect cannot lift it.
    if (this.window.requests >= WINDOW_MAX_REQUESTS) {
      this.log.info("pairing window not re-advertised: admission cap reached; closing");
      this.closeWindow();
      return;
    }
    const sent = this.opts.sendCtrl({
      type: "pairing-open",
      gateHash: sha256(this.window.gate),
      expiresAt: this.window.expiresAt,
    });
    this.log.debug(sent ? "pairing window re-advertised" : "pairing window re-advertise dropped");
  }

  closeWindow(): void {
    if (!this.window) return;
    const window = this.window;
    window.code.fill(0);
    window.gate.fill(0);
    this.window = null;
    if (this.pending?.window === window) this.pending = null;
    this.opts.sendCtrl({ type: "pairing-close" });
    this.log.info("pairing window closed");
    this.opts.onClose?.();
  }

  /** Call once per second. */
  tick(): void {
    if (this.window && this.now() >= this.window.expiresAt) this.closeWindow();
  }

  private confirmWithTimeout(phoneFp: string, name: string): Promise<boolean> {
    const timeoutMs = this.opts.confirmTimeoutMs ?? 60_000;
    return new Promise<boolean>((resolve) => {
      let settled = false;
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        this.log.warn("confirmation timed out", { phone: phoneFp.slice(0, 8) });
        resolve(false);
      }, timeoutMs);
      if (typeof timer.unref === "function") timer.unref();
      this.opts.confirm(phoneFp, name).then(
        (ok) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          resolve(ok);
        },
        () => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          resolve(false);
        },
      );
    });
  }

  async handleRequest(msg: CtrlMessageOf<"pairing-request">): Promise<void> {
    const reject = (reason: CtrlMessageOf<"pairing-reject">["reason"]) => {
      this.opts.sendCtrl({ type: "pairing-reject", phoneFp: msg.phoneFp, reason });
      this.log.warn("pairing rejected", { reason, phone: msg.phoneFp.slice(0, 8) });
    };
    if (!this.isOpen || !this.window) return reject("window-closed");
    this.window.requests += 1;
    if (this.opts.pairingCount() >= MAX_PAIRINGS) return reject("too-many");
    if (this.pending !== null) return reject("too-many");
    const win = this.window;
    const kPsk = derivePskKey(win.code, this.opts.fp);
    let body: z.infer<typeof RequestBody>;
    try {
      body = RequestBody.parse(
        decodeCbor(open(kPsk, msg.box, pairingAd("request", this.opts.fp, msg.phoneFp))),
      );
      if (fingerprint(body.ed25519Pub) !== msg.phoneFp) throw new Error("fp mismatch");
    } catch {
      win.failures += 1;
      reject("bad-code");
      if (win.failures >= 3) this.closeWindow();
      return;
    }

    const token = {};
    this.pending = { window: win, token };
    try {
      const ok = await this.confirmWithTimeout(msg.phoneFp, body.name);
      // Obsolete attempts must stay silent: relay rejection routing is phoneFp-only.
      if (this.pending?.token !== token || !this.isOpen || this.window !== win) return;
      if (!ok) return reject("declined");

      let kPair: Uint8Array;
      try {
        kPair = derivePairKey(
          this.opts.identity.x25519.priv,
          body.x25519Pub,
          win.code,
          this.opts.fp,
          msg.phoneFp,
        );
      } catch {
        win.failures += 1;
        reject("bad-code");
        if (win.failures >= 3) this.closeWindow();
        return;
      }

      this.opts.savePairing({
        phoneFp: msg.phoneFp,
        name: body.name,
        platform: body.platform,
        ed25519Pub: toBase64Url(body.ed25519Pub),
        x25519Pub: toBase64Url(body.x25519Pub),
        kPair: toBase64Url(kPair),
        pairedAt: new Date(this.now()).toISOString(),
        lastSeenAt: null,
      });
      this.opts.sendCtrl({
        type: "pairing-add",
        phoneFp: msg.phoneFp,
        ed25519Pub: body.ed25519Pub,
        name: body.name,
        pairId: pairRevocationIdV2(kPair),
      });
      const response = seal(
        kPsk,
        encodeCbor({
          x25519Pub: this.opts.identity.x25519.pub,
          computerName: this.opts.computerName,
          accent: this.opts.accent,
        }),
        pairingAd("response", this.opts.fp, msg.phoneFp),
      );
      this.opts.sendCtrl({ type: "pairing-response", phoneFp: msg.phoneFp, box: response });
      this.log.info("paired", { phone: msg.phoneFp.slice(0, 8) });
      this.closeWindow();
    } finally {
      if (this.pending?.token === token) this.pending = null;
    }
  }
}
