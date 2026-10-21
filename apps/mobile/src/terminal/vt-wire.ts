import { VT_MESSAGE_BYTES } from "./vt-limits";
import type { VtHistoryHeader } from "./vt-replay-log";

export { VT_MESSAGE_BYTES } from "./vt-limits";
export type VtCheckpointCommand =
  | { kind: "capture"; cols: number; rows: number }
  | { kind: "restore"; cols: number; rows: number; history: VtHistoryHeader }
  | { kind: "history"; offset: number }
  | { kind: "seed"; complete: boolean }
  | { kind: "tail" };

/** One bounded local WebView operation. Epoch fences reload/replay/source transitions. */
export interface TerminalVtMessage {
  document: string;
  sequence: number;
  /** Optional only for legacy local renderer fixtures. Native bridges always provide it. */
  epoch?: number;
  reset?: { cols: number; rows: number };
  checkpoint?: VtCheckpointCommand;
  /** Canonical base64, at most VT_MESSAGE_BYTES decoded. */
  data: string;
}

export type VtRenderError = "invalid-transfer" | "checkpoint-missing" | "renderer";
export type VtRendererEvent = { document: string; sequence: number; epoch: number } & (
  | { type: "vt-ack" }
  | { type: "vt-error"; reason: VtRenderError }
  | { type: "vt-history-start"; history: VtHistoryHeader }
  | { type: "vt-history-part"; offset: number; data: string }
  | { type: "vt-history-end" }
);

const BASE64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
const LOOKUP = new Map([...BASE64].map((character, index) => [character, index]));

export function encodeVtBytes(bytes: Uint8Array): string {
  if (bytes.byteLength > VT_MESSAGE_BYTES) throw new Error("Terminal byte message too large");
  let out = "";
  let i = 0;
  for (; i + 2 < bytes.length; i += 3) {
    const n = (bytes[i]! << 16) | (bytes[i + 1]! << 8) | bytes[i + 2]!;
    out += BASE64[n >> 18]! + BASE64[(n >> 12) & 63]! + BASE64[(n >> 6) & 63]! + BASE64[n & 63]!;
  }
  if (i < bytes.length) {
    const n = (bytes[i]! << 16) | ((bytes[i + 1] ?? 0) << 8);
    out += BASE64[n >> 18]! + BASE64[(n >> 12) & 63]!;
    out += i + 1 < bytes.length ? `${BASE64[(n >> 6) & 63]}=` : "==";
  }
  return out;
}

export function decodeVtBytes(text: string): Uint8Array {
  if (
    typeof text !== "string" ||
    text.length > Math.ceil(VT_MESSAGE_BYTES / 3) * 4 ||
    text.length % 4 !== 0 ||
    !/^[A-Za-z0-9+/]*={0,2}$/.test(text)
  )
    throw new Error("Invalid terminal byte message");
  const padding = text.endsWith("==") ? 2 : text.endsWith("=") ? 1 : 0;
  const size = (text.length / 4) * 3 - padding;
  if (size < 0 || size > VT_MESSAGE_BYTES) throw new Error("Invalid terminal byte message");
  const bytes = new Uint8Array(size);
  for (let at = 0, out = 0; at < text.length; at += 4) {
    const a = LOOKUP.get(text[at]!)!;
    const b = LOOKUP.get(text[at + 1]!)!;
    const c = LOOKUP.get(text[at + 2]!) ?? 0;
    const d = LOOKUP.get(text[at + 3]!) ?? 0;
    if (
      at + 4 === text.length &&
      ((padding === 2 && (b & 15) !== 0) || (padding === 1 && (c & 3) !== 0))
    )
      throw new Error("Invalid terminal byte message");
    const n = (a << 18) | (b << 12) | (c << 6) | d;
    if (out < size) bytes[out++] = n >> 16;
    if (out < size) bytes[out++] = n >> 8;
    if (out < size) bytes[out++] = n;
  }
  return bytes;
}
