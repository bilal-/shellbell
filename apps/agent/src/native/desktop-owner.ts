import type { Readable } from "node:stream";
import { z } from "zod";
import { NativeControllerError } from "./protocol.js";

const Handshake = z.strictObject({ v: z.literal(1), instance: z.uuid() });
export function bindDesktopOwner(
  input: Readable,
  options: { instance: string; onLost(): Promise<void>; timeoutMs?: number },
): { ready: Promise<void>; close(): void } {
  let resolve!: () => void, reject!: (error: Error) => void;
  const ready = new Promise<void>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  let accepted = false,
    closed = false,
    bytes = Buffer.alloc(0);
  const timer = setTimeout(() => lose(), options.timeoutMs ?? 5000);
  const detach = () => {
    clearTimeout(timer);
    input.off("data", data);
    input.off("end", lose);
    input.off("close", lose);
    input.off("error", lose);
  };
  const lose = () => {
    if (closed) return;
    closed = true;
    detach();
    reject(new NativeControllerError("unavailable"));
    // Losing ownership is irreversible. The engine wrapper handles a loss
    // racing asynchronous creation; repeated stream events cannot stop twice.
    void Promise.resolve()
      .then(() => options.onLost())
      .catch(() => {});
  };
  const data = (chunk: Buffer | string) => {
    if (closed) return;
    const next = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    if (accepted || bytes.length + next.length > 1024) {
      lose();
      return;
    }
    bytes = Buffer.concat([bytes, next]);
    const end = bytes.indexOf(10);
    if (end < 0) return;
    try {
      const value = Handshake.parse(
        JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(0, end))),
      );
      if (end !== bytes.length - 1 || value.instance !== options.instance) throw new Error();
      accepted = true;
      bytes = Buffer.alloc(0);
      clearTimeout(timer);
      resolve();
    } catch {
      lose();
    }
  };
  input.on("data", data);
  input.once("end", lose);
  input.once("close", lose);
  input.once("error", lose);
  if (input.destroyed || input.readableEnded) lose();
  return { ready, close: lose };
}
