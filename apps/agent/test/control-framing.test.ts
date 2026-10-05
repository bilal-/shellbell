import { describe, expect, it } from "vitest";
import * as control from "../src/control.js";

describe("bounded control framing", () => {
  it("decodes a split UTF-8 JSON line through the public control module", () => {
    // Removing the public framing export or decoding individual chunks corrupts this line.
    expect(control.ControlLineDecoder).toBeTypeOf("function");

    const lines: string[] = [];
    const errors: string[] = [];
    const decoder = new control.ControlLineDecoder({
      onLine: (line) => lines.push(line),
      onError: (code) => errors.push(code),
    });
    const frame = new TextEncoder().encode('{"name":"界"}\n');
    for (const byte of frame) decoder.push(Uint8Array.of(byte));

    expect(lines).toEqual(['{"name":"界"}']);
    expect(errors).toEqual([]);
  });

  it("enforces the byte cap before decoding a complete or partial line", () => {
    // Raising the boundary by one byte must reject an input before it is retained or decoded.
    const lines: string[] = [];
    const errors: string[] = [];
    const decoder = new control.ControlLineDecoder({
      onLine: (line) => lines.push(line),
      onError: (code) => errors.push(code),
    });
    decoder.push(new Uint8Array(control.CONTROL_LIMITS.lineBytes).fill(97));
    decoder.push(Uint8Array.of(10));
    decoder.push(new Uint8Array(control.CONTROL_LIMITS.lineBytes + 1).fill(98));

    expect(lines).toEqual(["a".repeat(control.CONTROL_LIMITS.lineBytes)]);
    expect(errors).toEqual(["line-too-large"]);
  });

  it("accepts lineBytes minus one and rejects a complete line one byte over the cap", () => {
    // Changing either byte comparison silently changes the advertised wire boundary.
    const nearLines: string[] = [];
    const near = new control.ControlLineDecoder({
      onLine: (line) => nearLines.push(line),
      onError: () => {},
    });
    near.push(new Uint8Array(control.CONTROL_LIMITS.lineBytes - 1).fill(97));
    near.push(Uint8Array.of(10));
    expect(nearLines).toEqual(["a".repeat(control.CONTROL_LIMITS.lineBytes - 1)]);

    const errors: string[] = [];
    const over = new control.ControlLineDecoder({
      onLine: () => {},
      onError: (code) => errors.push(code),
    });
    over.push(new Uint8Array(control.CONTROL_LIMITS.lineBytes + 1).fill(97));
    over.push(Uint8Array.of(10));
    expect(errors).toEqual(["line-too-large"]);
  });

  it("decodes coalesced frames independently", () => {
    // Processing only the first newline would drop later responses in one socket read.
    const lines: string[] = [];
    const decoder = new control.ControlLineDecoder({
      onLine: (line) => lines.push(line),
      onError: () => {},
    });
    decoder.push(new TextEncoder().encode('{"one":1}\n{"two":2}\n'));
    expect(lines).toEqual(['{"one":1}', '{"two":2}']);
  });

  it("preserves a BOM, rejects malformed UTF-8, and reports unfinished EOF once", () => {
    // Replacing fatal decoding or treating partial EOF as a valid line corrupts the transport.
    const bomLines: string[] = [];
    const bomErrors: string[] = [];
    const bom = new control.ControlLineDecoder({
      onLine: (line) => bomLines.push(line),
      onError: (code) => bomErrors.push(code),
    });
    bom.push(Uint8Array.of(0xef, 0xbb, 0xbf, 123, 125, 10));
    expect(bomLines).toEqual(["\ufeff{}"]);
    expect(bomErrors).toEqual([]);

    const errors: string[] = [];
    const invalid = new control.ControlLineDecoder({
      onLine: () => {},
      onError: (code) => errors.push(code),
    });
    invalid.push(Uint8Array.of(0xc3, 0x28, 10));
    invalid.push(Uint8Array.of(123, 125, 10));
    invalid.finish();
    expect(errors).toEqual(["invalid-utf8"]);

    const eofErrors: string[] = [];
    const eof = new control.ControlLineDecoder({
      onLine: () => {},
      onError: (code) => eofErrors.push(code),
    });
    eof.push(new TextEncoder().encode('{"partial":true}'));
    eof.finish();
    eof.finish();
    expect(eofErrors).toEqual(["incomplete-line"]);
  });

  it("copies a retained Buffer fragment before its caller can mutate the backing store", () => {
    // Retaining a Buffer view would both pin its large allocation and decode its later mutation.
    const lines: string[] = [];
    const decoder = new control.ControlLineDecoder({
      onLine: (line) => lines.push(line),
      onError: () => {},
    });
    const backing = Buffer.alloc(1_048_576);
    backing[0] = 97;
    decoder.push(backing.subarray(0, 1));
    backing[0] = 98;
    decoder.push(Uint8Array.of(10));

    expect(lines).toEqual(["a"]);
  });

  it("encodes one bounded line and destroys only unsafe output sockets", () => {
    // Treating write(false) as refusal retries application output; only an unsafe queue must close.
    const frame = control.encodeControlLine({ ok: true, data: {} });
    expect(frame?.at(-1)).toBe(10);
    expect(control.encodeControlLine({ value: BigInt(1) })).toBeNull();
    expect(control.encodeControlLine("x".repeat(control.CONTROL_LIMITS.lineBytes + 1))).toBeNull();

    const accepted = {
      destroyed: false,
      writableLength: control.CONTROL_LIMITS.queuedBytes - frame!.byteLength,
      write: () => false,
      destroy() {
        this.destroyed = true;
        return this as never;
      },
    };
    expect(control.writeControlLine(accepted, frame!)).toBe(true);
    expect(accepted.destroyed).toBe(false);

    const overLimit = {
      destroyed: false,
      writableLength: control.CONTROL_LIMITS.queuedBytes - frame!.byteLength + 1,
      write: () => true,
      destroy() {
        this.destroyed = true;
        return this as never;
      },
    };
    expect(control.writeControlLine(overLimit, frame!)).toBe(false);
    expect(overLimit.destroyed).toBe(true);

    const throwing = {
      destroyed: false,
      writableLength: 0,
      write: () => {
        throw new Error("broken pipe");
      },
      destroy() {
        this.destroyed = true;
        return this as never;
      },
    };
    expect(control.writeControlLine(throwing, frame!)).toBe(false);
    expect(throwing.destroyed).toBe(true);

    const invalidLength = {
      destroyed: false,
      writableLength: Number.NaN,
      write: () => true,
      destroy() {
        this.destroyed = true;
        return this as never;
      },
    };
    expect(control.writeControlLine(invalidLength, frame!)).toBe(false);
    expect(invalidLength.destroyed).toBe(true);

    const closed = {
      destroyed: true,
      writableLength: 0,
      write: () => true,
      destroy() {
        return this as never;
      },
    };
    expect(control.writeControlLine(closed, frame!)).toBe(false);
  });
});
