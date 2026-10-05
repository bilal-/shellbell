import { decodeCborWithText, ProtocolError } from "./codec.js";
import { STREAM_LIMITS } from "./stream-wire.js";

export const STREAM_CBOR_MAX_DEPTH = 12;

function malformed(): never {
  throw new ProtocolError("malformed");
}

/** Walk RFC 3629 scalars, optionally emitting code points to a bounded builder. */
function walkUtf8(bytes: Uint8Array, emit?: (codePoint: number) => void): void {
  for (let pos = 0; pos < bytes.length; ) {
    const first = bytes[pos++];
    if (first === undefined) malformed();
    if (first < 0x80) {
      emit?.(first);
      continue;
    }

    const width =
      first >= 0xc2 && first <= 0xdf
        ? 2
        : first >= 0xe0 && first <= 0xef
          ? 3
          : first >= 0xf0 && first <= 0xf4
            ? 4
            : 0;
    if (width === 0 || pos + width - 1 > bytes.length) malformed();
    const second = bytes[pos++];
    if (second === undefined || second < 0x80 || second > 0xbf) malformed();
    if (
      (first === 0xe0 && second < 0xa0) ||
      (first === 0xed && second > 0x9f) ||
      (first === 0xf0 && second < 0x90) ||
      (first === 0xf4 && second > 0x8f)
    )
      malformed();

    let scalar =
      ((first & (width === 2 ? 0x1f : width === 3 ? 0x0f : 0x07)) << 6) | (second & 0x3f);
    for (let i = 2; i < width; i++) {
      const next = bytes[pos++];
      if (next === undefined || next < 0x80 || next > 0xbf) malformed();
      scalar = (scalar << 6) | (next & 0x3f);
    }
    emit?.(scalar);
  }
}

function decodeValidatedText(bytes: Uint8Array): string {
  const pieces: string[] = [];
  const units: number[] = [];
  const flush = () => {
    if (units.length > 0) {
      pieces.push(String.fromCharCode(...units));
      units.length = 0;
    }
  };
  walkUtf8(bytes, (scalar) => {
    if (scalar <= 0xffff) {
      units.push(scalar);
    } else {
      const astral = scalar - 0x10000;
      units.push(0xd800 | (astral >>> 10), 0xdc00 | (astral & 0x3ff));
    }
    if (units.length >= 4096) flush();
  });
  flush();
  return pieces.join("");
}

type Frame = { remaining: number; map: boolean };

/** Reject unsupported CBOR and impossible lengths before cborg allocates or recurses. */
function preflight(bytes: Uint8Array, allowBytes: boolean): void {
  let pos = 0;
  const stack: Frame[] = [{ remaining: 1, map: false }];
  while (stack.length > 0) {
    const frame = stack[stack.length - 1];
    if (!frame) malformed();
    if (frame.remaining === 0) {
      stack.pop();
      continue;
    }
    if (pos >= bytes.length) malformed();

    const keyExpected = frame.map && frame.remaining % 2 === 0;
    frame.remaining--;
    const head = bytes[pos++];
    if (head === undefined) malformed();
    const major = head >>> 5;
    const info = head & 31;
    if (keyExpected && major !== 3) malformed();
    if (major === 7) {
      if (info !== 20 && info !== 21) malformed();
      continue;
    }
    if (
      major !== 0 &&
      major !== 1 &&
      major !== 3 &&
      major !== 4 &&
      major !== 5 &&
      !(allowBytes && major === 2)
    )
      malformed();
    if (info >= 28) malformed();

    let argument: bigint;
    if (info < 24) {
      argument = BigInt(info);
    } else {
      const width = info === 24 ? 1 : info === 25 ? 2 : info === 26 ? 4 : 8;
      if (width > bytes.length - pos) malformed();
      argument = 0n;
      for (let i = 0; i < width; i++)
        argument = (argument << 8n) | BigInt(bytes[pos++] ?? malformed());
    }

    if (major === 0 || major === 1) {
      const maxArgument = BigInt(Number.MAX_SAFE_INTEGER - (major === 1 ? 1 : 0));
      if (argument > maxArgument) malformed();
      continue;
    }
    if (argument > BigInt(bytes.length - pos)) malformed();
    const length = Number(argument);
    if (major === 3 || major === 2) {
      if (major === 3) walkUtf8(bytes.subarray(pos, pos + length));
      pos += length;
      continue;
    }
    const children = major === 5 ? length * 2 : length;
    if (children > bytes.length - pos || stack.length > STREAM_CBOR_MAX_DEPTH) malformed();
    stack.push({ remaining: children, map: major === 5 });
  }
  if (pos !== bytes.length) malformed();
}

export function decodeBoundedRecord(
  bytes: Uint8Array,
  maxBytes: number,
  options: { allowBytes?: boolean } = {},
): unknown {
  if (
    !(bytes instanceof Uint8Array) ||
    !Number.isSafeInteger(maxBytes) ||
    maxBytes < 1 ||
    maxBytes > STREAM_LIMITS.screenBytes ||
    bytes.length === 0 ||
    bytes.length > maxBytes
  )
    malformed();
  preflight(bytes, options.allowBytes === true);
  return decodeCborWithText(bytes, decodeValidatedText);
}
