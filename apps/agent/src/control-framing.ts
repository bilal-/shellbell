import type { Socket } from "node:net";

export const CONTROL_LIMITS = {
  lineBytes: 65_536,
  queuedBytes: 262_144,
  connections: 16,
  initialRequestMs: 5_000,
  requestMs: 5_000,
  challengeMs: 60_000,
} as const;

export type ControlFrameError = "invalid-utf8" | "line-too-large" | "incomplete-line";

/** Encodes one complete JSONL frame, or refuses values that cannot fit on the wire. */
export function encodeControlLine(value: unknown): Uint8Array | null {
  let json: string | undefined;
  try {
    json = JSON.stringify(value);
  } catch {
    return null;
  }
  if (json === undefined) return null;

  const frame = new TextEncoder().encode(`${json}\n`);
  return frame.byteLength - 1 <= CONTROL_LIMITS.lineBytes ? frame : null;
}

/** Writes a previously encoded frame without permitting an application-level output queue. */
export function writeControlLine(
  socket: Pick<Socket, "destroyed" | "writableLength" | "write" | "destroy">,
  frame: Uint8Array,
): boolean {
  const queued = socket.writableLength;
  if (
    socket.destroyed ||
    !Number.isFinite(queued) ||
    queued < 0 ||
    queued + frame.byteLength > CONTROL_LIMITS.queuedBytes
  ) {
    socket.destroy();
    return false;
  }
  try {
    // `false` means Node accepted bytes but its transport buffer crossed its high-water mark.
    socket.write(frame);
    return true;
  } catch {
    socket.destroy();
    return false;
  }
}

/** Decodes bounded UTF-8 JSONL transport frames without retaining an unbounded partial line. */
export class ControlLineDecoder {
  private readonly onLine: (line: string) => void;
  private readonly onError: (code: ControlFrameError) => void;
  private readonly maxBytes: number;
  private chunks: Uint8Array[] = [];
  private bytes = 0;
  private terminal = false;

  constructor(options: {
    onLine: (line: string) => void;
    onError: (code: ControlFrameError) => void;
    maxBytes?: number;
  }) {
    this.onLine = options.onLine;
    this.onError = options.onError;
    const requested = options.maxBytes ?? CONTROL_LIMITS.lineBytes;
    this.maxBytes = Number.isFinite(requested)
      ? Math.max(0, Math.min(requested, CONTROL_LIMITS.lineBytes))
      : CONTROL_LIMITS.lineBytes;
  }

  push(chunk: Uint8Array): void {
    if (this.terminal || chunk.byteLength === 0) return;

    let start = 0;
    while (start < chunk.byteLength && !this.terminal) {
      const newline = chunk.indexOf(10, start);
      const end = newline === -1 ? chunk.byteLength : newline;
      const length = end - start;
      if (this.bytes + length > this.maxBytes) {
        this.fail("line-too-large");
        return;
      }
      if (length > 0) {
        // Copy the fragment so a Buffer view cannot retain or later mutate a larger input chunk.
        this.chunks.push(Uint8Array.from(chunk.subarray(start, end)));
        this.bytes += length;
      }
      if (newline === -1) return;

      const line = this.decodeLine();
      if (line === null) return;
      this.reset();
      this.onLine(line);
      start = newline + 1;
    }
  }

  finish(): void {
    if (this.terminal) return;
    if (this.bytes > 0) this.fail("incomplete-line");
    else {
      this.terminal = true;
      this.reset();
    }
  }

  private decodeLine(): string | null {
    const bytes = new Uint8Array(this.bytes);
    let offset = 0;
    for (const chunk of this.chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    try {
      return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
    } catch {
      this.fail("invalid-utf8");
      return null;
    }
  }

  private fail(code: ControlFrameError): void {
    if (this.terminal) return;
    this.terminal = true;
    this.reset();
    this.onError(code);
  }

  private reset(): void {
    this.chunks = [];
    this.bytes = 0;
  }
}
