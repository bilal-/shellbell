import { decode, encode } from "cborg";

export class ProtocolError extends Error {
  constructor(
    public readonly code: "malformed" | "unsupported" | "crypto" | "replay",
    message?: string,
  ) {
    super(message ? `${code}: ${message}` : code);
    this.name = "ProtocolError";
  }
}

/** The only place cborg is called. Optional (undefined) properties never hit the wire. */
export function encodeCbor(value: unknown): Uint8Array {
  return encode(value, { ignoreUndefinedProperties: true });
}

export function decodeCbor(bytes: Uint8Array): unknown {
  try {
    return decode(bytes, { rejectDuplicateMapKeys: true });
  } catch (err) {
    throw new ProtocolError("malformed", (err as Error).message);
  }
}
