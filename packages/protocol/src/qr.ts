import { z } from "zod";
import { fromBase64Url } from "./bytes.js";
import { ProtocolError } from "./codec.js";
import { fingerprint } from "./crypto.js";
import { FpSchema } from "./envelope.js";

const b64u16 = z.string().regex(/^[A-Za-z0-9_-]{22}$/);

export const QrPayloadSchema = z.object({
  v: z.literal(1),
  r: z.url().max(256),
  c: FpSchema,
  e: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
  n: z.string().min(1).max(40),
  p: b64u16,
  g: b64u16,
});
export type QrPayload = z.infer<typeof QrPayloadSchema>;

export function encodeQr(p: QrPayload): string {
  return JSON.stringify(p);
}

export function parseQr(text: string, opts: { allowInsecure?: boolean } = {}): QrPayload {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new ProtocolError("malformed", "qr: not json");
  }
  const r = QrPayloadSchema.safeParse(raw);
  if (!r.success) throw new ProtocolError("malformed", `qr: ${z.prettifyError(r.error)}`);
  const p = r.data;
  const url = new URL(p.r);
  if (url.username || url.password)
    throw new ProtocolError("malformed", "qr: relay url must not contain credentials");
  if (url.protocol !== "wss:" && !(opts.allowInsecure && url.protocol === "ws:")) {
    throw new ProtocolError("malformed", "qr: relay must be wss://");
  }
  if (p.r.endsWith("/") || url.pathname !== "/" || url.search || url.hash) {
    throw new ProtocolError("malformed", "qr: relay url must be scheme://host[:port] with no path");
  }
  if (fingerprint(fromBase64Url(p.e)) !== p.c)
    throw new ProtocolError("malformed", "qr: fingerprint mismatch");
  return p;
}

/** `${r}/ws/${fp}` — r is validated to have no trailing slash. */
export function relayWsUrl(r: string, fp: string): string {
  return `${r}/ws/${fp}`;
}
