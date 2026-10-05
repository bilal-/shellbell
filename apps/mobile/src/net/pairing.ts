import {
  authMessage,
  type CtrlMessageLoose,
  decodeCbor,
  decodeEnvelope,
  derivePairKey,
  derivePskKey,
  encodeCbor,
  encodeEnvelope,
  fromBase64Url,
  type Identity,
  open,
  pairingAd,
  parseCtrlLoose,
  parseQr,
  type QrPayload,
  relayWsUrl,
  seal,
  sign,
} from "@shellbell/protocol";
import { z } from "zod";
import type { PairSecret } from "../identity/keys";

export type PairingCode =
  | "bad-qr"
  | "bad-code"
  | "declined"
  | "no-window"
  | "no-agent"
  | "too-many"
  | "timeout"
  | "relay";

export class PairingError extends Error {
  constructor(public readonly code: PairingCode) {
    super(code);
    this.name = "PairingError";
  }
}

export interface PairingResult {
  computerFp: string;
  computerName: string;
  accent: string;
  relayUrl: string;
  secret: PairSecret;
}

const Key32 = z
  .instanceof(Uint8Array)
  .refine((b) => b.length === 32, { message: "expected 32 bytes" });

const ResponseBody = z.object({
  x25519Pub: Key32,
  computerName: z.string().min(1).max(64),
  accent: z.string().min(1).max(32),
});

/** Spec 10.7: validate the QR *before* any socket opens so the sheet can name the computer. */
export function parsePairingQr(
  text: string,
  opts: { allowInsecure?: boolean } = {},
): { qr: QrPayload; displayName: string; fpPrefix: string } {
  let qr: QrPayload;
  try {
    qr = parseQr(text, opts);
  } catch {
    throw new PairingError("bad-qr");
  }
  return { qr, displayName: qr.n, fpPrefix: `${qr.c.slice(0, 4)}-${qr.c.slice(4, 8)}` };
}

const REJECT_TO_CODE: Record<string, PairingCode> = {
  declined: "declined",
  "bad-code": "bad-code",
  "no-agent": "no-agent",
  "too-many": "too-many",
  "window-closed": "no-window",
};

const AUTH_FAIL_TO_CODE: Record<string, PairingCode> = {
  "no-agent": "no-agent",
  "no-window": "no-window",
  timeout: "timeout",
};

/** Spec 12 close codes seen by a pairing socket. */
const CLOSE_TO_CODE: Record<number, PairingCode> = {
  4001: "no-window",
  4003: "declined",
  4408: "timeout",
  4413: "relay",
  4429: "relay",
};

export function runPairing(o: {
  qr: QrPayload;
  identity: Identity;
  phoneFp: string;
  phoneName: string;
  platform: "ios" | "android";
  appVersion: string;
  WebSocketImpl?: new (url: string) => WebSocket;
  timeoutMs?: number;
}): Promise<PairingResult> {
  return new Promise<PairingResult>((resolve, reject) => {
    const { qr } = o;
    const code = fromBase64Url(qr.p);
    const gate = fromBase64Url(qr.g);
    const kPsk = derivePskKey(code, qr.c);
    const Ws = o.WebSocketImpl ?? WebSocket;
    const ws = new Ws(relayWsUrl(qr.r, qr.c));
    ws.binaryType = "arraybuffer";

    let settled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;

    // Declared before every handler that can call it.
    const finish = (err: PairingError | null, value?: PairingResult) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      timer = null;
      try {
        ws.close();
      } catch {
        /* already closing */
      }
      if (err) reject(err);
      else if (value) resolve(value);
      else reject(new PairingError("relay"));
    };

    // The relay closes a pairing socket at 90 s; stay just inside that so our copy wins the race.
    timer = setTimeout(() => finish(new PairingError("timeout")), o.timeoutMs ?? 88_000);

    const sendCtrl = (body: CtrlMessageLoose) => {
      ws.send(encodeEnvelope({ v: 1, t: "ctrl", from: o.phoneFp, seq: 0, body } as never));
    };

    ws.onerror = () => finish(new PairingError("relay"));
    ws.onclose = (ev) => finish(new PairingError(CLOSE_TO_CODE[ev.code] ?? "relay"));

    ws.onmessage = (ev) => {
      try {
        if (typeof ev.data === "string") return;
        const env = decodeEnvelope(new Uint8Array(ev.data as ArrayBuffer));
        if (env.t !== "ctrl") return;
        const m = parseCtrlLoose(env.body);
        switch (m.type) {
          case "challenge": {
            const msg = authMessage(m.connId, "pairing", o.phoneFp, m.nonce);
            sendCtrl({
              type: "auth",
              role: "pairing",
              fp: o.phoneFp,
              ed25519Pub: o.identity.ed25519.pub,
              sig: sign(o.identity.ed25519.priv, msg),
              name: o.phoneName,
              appVersion: o.appVersion,
              gate,
            });
            return;
          }
          case "auth-ok": {
            const box = seal(
              kPsk,
              encodeCbor({
                ed25519Pub: o.identity.ed25519.pub,
                x25519Pub: o.identity.x25519.pub,
                name: o.phoneName,
                platform: o.platform,
              }),
              pairingAd("request", qr.c, o.phoneFp),
            );
            sendCtrl({ type: "pairing-request", phoneFp: o.phoneFp, box });
            return;
          }
          case "auth-fail":
            finish(new PairingError(AUTH_FAIL_TO_CODE[m.reason] ?? "relay"));
            return;
          case "pairing-reject":
            finish(new PairingError(REJECT_TO_CODE[m.reason] ?? "no-window"));
            return;
          case "pairing-response": {
            // Isolated from the outer catch: only a genuine failure to open/validate *this* box
            // (wrong code, tampered box, a low-order X25519 point) means "bad-code" -- a decode or
            // send fault anywhere else in this handler is a relay-side/wire fault, not proof the
            // pairing code itself is wrong.
            let result: PairingResult;
            try {
              const ad = pairingAd("response", qr.c, o.phoneFp);
              const body = ResponseBody.parse(decodeCbor(open(kPsk, m.box, ad)));
              const kPair = derivePairKey(
                o.identity.x25519.priv,
                body.x25519Pub,
                code,
                qr.c,
                o.phoneFp,
              );
              result = {
                computerFp: qr.c,
                computerName: body.computerName,
                accent: body.accent,
                relayUrl: qr.r,
                secret: {
                  kPair,
                  computerEd25519Pub: fromBase64Url(qr.e),
                  computerX25519Pub: body.x25519Pub,
                },
              };
            } catch {
              finish(new PairingError("bad-code"));
              return;
            }
            finish(null, result);
            return;
          }
          default:
            return;
        }
      } catch {
        // A malformed envelope, an unrecognised ctrl enum, or a `ws.send` failure: never throw
        // into the socket callback, but this is a wire/relay fault, not evidence of a bad code.
        finish(new PairingError("relay"));
      }
    };
  });
}
