import { decode, encode, Token, Tokenizer, Type } from "cborg";

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

/** Internal adapter for bounded records whose validated text must retain U+FEFF. */
export function decodeCborWithText(
  bytes: Uint8Array,
  decodeText: (bytes: Uint8Array) => string,
): unknown {
  try {
    const base = new Tokenizer(bytes, { retainStringBytes: true });
    const tokenizer = {
      done: () => base.done(),
      pos: () => base.pos(),
      next: () => {
        const token = base.next();
        if (token.type !== Type.string) return token;
        // cborg's cached canonical empty-string token does not retain byteValue.
        if (token.value === "" && token.encodedLength === 1) return token;
        if (!token.byteValue) throw new ProtocolError("malformed");
        return new Token(Type.string, decodeText(token.byteValue), token.encodedLength);
      },
    };
    return decode(bytes, { rejectDuplicateMapKeys: true, tokenizer });
  } catch {
    // cborg errors can quote a supplied map key; bounded errors never do.
    throw new ProtocolError("malformed");
  }
}
