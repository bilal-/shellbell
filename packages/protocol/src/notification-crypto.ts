import { gcm } from "@noble/ciphers/aes.js";
import { hkdf } from "@noble/hashes/hkdf.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { randomBytes } from "@noble/hashes/utils.js";
import { bytesEqual, fromBase64Url, fromUtf8, toBase64Url, utf8 } from "./bytes.js";
import { ProtocolError } from "./codec.js";
import {
  NOTIFICATION_DOMAIN,
  NOTIFICATION_LIMITS,
  type NotificationBox,
  NotificationBoxSchema,
  type NotificationHeader,
  NotificationHeaderSchema,
  type NotificationPayload,
  NotificationPayloadSchema,
  notificationHeader,
} from "./notification.js";

function checkKey(key: Uint8Array): void {
  if (!(key instanceof Uint8Array) || key.length !== 32)
    throw new ProtocolError("crypto", "invalid notification key");
}
export type NotificationKeyScope = Pick<
  NotificationHeader,
  "computerFp" | "phoneFp" | "generation"
>;
const keyScopeSchema = NotificationHeaderSchema.pick({
  computerFp: true,
  phoneFp: true,
  generation: true,
});

export function deriveNotificationKey(pairKey: Uint8Array, h: NotificationKeyScope): Uint8Array {
  checkKey(pairKey);
  const header = keyScopeSchema.parse({
    computerFp: h.computerFp,
    phoneFp: h.phoneFp,
    generation: h.generation,
  });
  return hkdf(
    sha256,
    pairKey,
    utf8(NOTIFICATION_DOMAIN),
    utf8(JSON.stringify([header.computerFp, header.phoneFp, header.generation])),
    32,
  );
}
export function notificationAd(h: NotificationHeader): Uint8Array {
  const p = notificationHeader(h);
  return utf8(
    JSON.stringify([
      NOTIFICATION_DOMAIN,
      p.computerFp,
      p.phoneFp,
      p.generation,
      p.sessionId,
      p.eventId,
    ]),
  );
}
/** Caller must durably reserve usage first. Never accept a caller-supplied nonce. */
export function sealNotification(key: Uint8Array, value: NotificationPayload): NotificationBox {
  try {
    checkKey(key);
    const payload = NotificationPayloadSchema.parse(value);
    const header = notificationHeader(payload);
    const nonce = randomBytes(12);
    const plaintext = utf8(JSON.stringify(payload));
    try {
      const ciphertext = gcm(key, nonce, notificationAd(header)).encrypt(plaintext);
      return { ...header, nonce: toBase64Url(nonce), ciphertext: toBase64Url(ciphertext) };
    } finally {
      plaintext.fill(0);
    }
  } catch {
    throw new ProtocolError("crypto", "notification seal failed");
  }
}
/** Caller binds recipient to its key record and applies expiry/replay policy. */
export function openNotification(key: Uint8Array, value: NotificationBox): NotificationPayload {
  let plaintext: Uint8Array | undefined;
  try {
    checkKey(key);
    const box = NotificationBoxSchema.parse(value);
    plaintext = gcm(key, fromBase64Url(box.nonce), notificationAd(box)).decrypt(
      fromBase64Url(box.ciphertext),
    );
    if (plaintext.length > NOTIFICATION_LIMITS.plaintextBytes) throw new Error();
    const text = fromUtf8(plaintext);
    if (!bytesEqual(utf8(text), plaintext)) throw new Error();
    const payload = NotificationPayloadSchema.parse(JSON.parse(text));
    if (!bytesEqual(notificationAd(payload), notificationAd(box))) throw new Error();
    return payload;
  } catch {
    throw new ProtocolError("crypto", "notification open failed");
  } finally {
    plaintext?.fill(0);
  }
}
