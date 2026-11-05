/** Small HTTP/1.1 helpers for the door: heads in latin1, bodies as bytes. */

export const MAX_HEAD_BYTES = 16 * 1024;

const encoder = new TextEncoder();

export function latin1(bytes: Uint8Array): string {
  let text = "";
  for (let i = 0; i < bytes.length; i += 8192)
    text += String.fromCharCode(...bytes.subarray(i, i + 8192));
  return text;
}

export function latin1Bytes(text: string): Uint8Array {
  const bytes = new Uint8Array(text.length);
  for (let i = 0; i < text.length; i++) bytes[i] = text.charCodeAt(i) & 0xff;
  return bytes;
}

export const utf8Bytes = (text: string) => encoder.encode(text);

export function concat(a: Uint8Array, b: Uint8Array): Uint8Array {
  if (a.length === 0) return b;
  if (b.length === 0) return a;
  const out = new Uint8Array(a.length + b.length);
  out.set(a);
  out.set(b, a.length);
  return out;
}

/** Index just past the blank line ending a head, or -1. */
export function headEnd(buffer: Uint8Array): number {
  for (let i = 3; i < buffer.length; i++)
    if (buffer[i] === 10 && buffer[i - 1] === 13 && buffer[i - 2] === 10 && buffer[i - 3] === 13)
      return i + 1;
  return -1;
}

export interface RequestHead {
  method: string;
  target: string;
  version: string;
  headers: Array<[string, string]>;
}

const TOKEN = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;

export function parseRequestHead(text: string): RequestHead | null {
  const lines = text.split("\r\n");
  const [method, target, version, ...extra] = (lines.shift() ?? "").split(" ");
  if (!method || !target || !version || extra.length || !TOKEN.test(method)) return null;
  if (version !== "HTTP/1.1" && version !== "HTTP/1.0") return null;
  const headers: Array<[string, string]> = [];
  for (const line of lines) {
    if (line === "") continue;
    const colon = line.indexOf(":");
    if (colon <= 0) return null;
    const name = line.slice(0, colon);
    if (!TOKEN.test(name)) return null;
    headers.push([name, line.slice(colon + 1).trim()]);
  }
  return { method, target, version, headers };
}

export const header = (headers: ReadonlyArray<readonly [string, string]>, name: string) =>
  headers.find(([n]) => n.toLowerCase() === name)?.[1];

export const headerAll = (headers: ReadonlyArray<readonly [string, string]>, name: string) =>
  headers.filter(([n]) => n.toLowerCase() === name).map(([, v]) => v);

export const REASONS: Record<number, string> = {
  101: "Switching Protocols",
  200: "OK",
  204: "No Content",
  302: "Found",
  304: "Not Modified",
  400: "Bad Request",
  403: "Forbidden",
  404: "Not Found",
  413: "Payload Too Large",
  431: "Request Header Fields Too Large",
  502: "Bad Gateway",
  503: "Service Unavailable",
  504: "Gateway Timeout",
};

export function serializeHead(status: number, headers: ReadonlyArray<readonly [string, string]>) {
  const lines = [`HTTP/1.1 ${status} ${REASONS[status] ?? "Status"}`];
  for (const [name, value] of headers) lines.push(`${name}: ${value}`);
  return latin1Bytes(`${lines.join("\r\n")}\r\n\r\n`);
}

/**
 * Decodes a chunked request body as bytes arrive. `push` returns the decoded bytes and whether the
 * body is complete; `rest` holds any bytes after it (the next request).
 */
export class ChunkedDecoder {
  private buffer: Uint8Array = new Uint8Array(0);
  private remaining = -1; // bytes left in the current chunk; -1 while reading a size line
  private trailer = false;
  done = false;
  rest: Uint8Array = new Uint8Array(0);

  push(input: Uint8Array): { bytes: Uint8Array; error?: true } {
    this.buffer = concat(this.buffer, input);
    const out: Uint8Array[] = [];
    while (!this.done) {
      if (this.trailer) {
        const end = indexOfCrlf(this.buffer);
        if (end < 0) break;
        const line = this.buffer.subarray(0, end);
        this.buffer = this.buffer.subarray(end + 2);
        if (line.length === 0) {
          this.done = true;
          this.rest = this.buffer;
        }
        continue;
      }
      if (this.remaining < 0) {
        const end = indexOfCrlf(this.buffer);
        if (end < 0) {
          if (this.buffer.length > 1024) return { bytes: new Uint8Array(0), error: true };
          break;
        }
        const size = Number.parseInt(latin1(this.buffer.subarray(0, end)).split(";")[0] ?? "", 16);
        if (!Number.isSafeInteger(size) || size < 0)
          return { bytes: new Uint8Array(0), error: true };
        this.buffer = this.buffer.subarray(end + 2);
        if (size === 0) this.trailer = true;
        else this.remaining = size;
        continue;
      }
      if (this.remaining > 0) {
        const n = Math.min(this.remaining, this.buffer.length);
        if (n === 0) break;
        out.push(this.buffer.slice(0, n));
        this.buffer = this.buffer.subarray(n);
        this.remaining -= n;
      }
      if (this.remaining === 0) {
        if (this.buffer.length < 2) break;
        this.buffer = this.buffer.subarray(2);
        this.remaining = -1;
      }
    }
    return { bytes: out.reduce(concat, new Uint8Array(0)) };
  }
}

function indexOfCrlf(buffer: Uint8Array): number {
  for (let i = 1; i < buffer.length; i++)
    if (buffer[i] === 10 && buffer[i - 1] === 13) return i - 1;
  return -1;
}

/** Response types a page view shows itself; anything else as a document is a download. */
export function showable(contentType: string | undefined): boolean {
  if (!contentType) return true;
  const type = contentType.split(";")[0]?.trim().toLowerCase() ?? "";
  return (
    type === "" ||
    type.startsWith("text/") ||
    type.startsWith("image/") ||
    type.startsWith("video/") ||
    type.startsWith("audio/") ||
    type === "application/json" ||
    type === "application/xhtml+xml" ||
    type === "application/xml" ||
    type.endsWith("+json") ||
    type.endsWith("+xml")
  );
}
