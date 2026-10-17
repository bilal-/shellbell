import { type ChildProcess, spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { type Logger, safeErrorName } from "../../log.js";

/**
 * From local captures (tmux 3.7c): ESC arrives as a literal 0x1B byte inside `%begin`/`%end`,
 * so reply lines need no unescaping. Only `%output` and `%extended-output` payloads are
 * octal-escaped; `unescapeOutput` restores their exact bytes.
 */
export const UNESCAPE_OCTAL = false;

/**
 * tmux escapes LF in pane output, so every control line ends at a real LF. A longer line means
 * the stream is not what this client expects; the client retires rather than buffering it.
 */
export const MAX_CONTROL_LINE_BYTES = 4 * 1024 * 1024;

const LF = 0x0a;
const CR = 0x0d;
const BACKSLASH = 0x5c;

/** Splits tmux's stdout into lines of bytes, so a UTF-8 character split across reads survives. */
export class ControlLineSplitter {
  private parts: Buffer[] = [];
  private length = 0;

  /** The complete lines in `chunk`, without their LF (or CRLF); throws past the line bound. */
  push(chunk: Buffer): Buffer[] {
    const lines: Buffer[] = [];
    let start = 0;
    for (let end = chunk.indexOf(LF); end !== -1; end = chunk.indexOf(LF, start)) {
      this.parts.push(chunk.subarray(start, end));
      this.length += end - start;
      this.check();
      let line = this.parts.length === 1 ? this.parts[0]! : Buffer.concat(this.parts, this.length);
      if (line.length > 0 && line[line.length - 1] === CR) line = line.subarray(0, -1);
      lines.push(line);
      this.parts = [];
      this.length = 0;
      start = end + 1;
    }
    if (start < chunk.length) {
      this.parts.push(chunk.subarray(start));
      this.length += chunk.length - start;
      this.check();
    }
    return lines;
  }

  private check(): void {
    if (this.length > MAX_CONTROL_LINE_BYTES) {
      this.parts = [];
      this.length = 0;
      throw new Error("tmux control line too long");
    }
  }
}

/** The exact bytes of an octal-escaped `%output` payload: `\\` and `\ooo` only. */
export function unescapeOutput(data: Buffer): Uint8Array {
  const out = new Uint8Array(data.length);
  let n = 0;
  for (let i = 0; i < data.length; i++) {
    const byte = data[i]!;
    if (byte === BACKSLASH && data[i + 1] === BACKSLASH) {
      out[n++] = BACKSLASH;
      i++;
    } else if (
      byte === BACKSLASH &&
      i + 3 < data.length &&
      isOctal(data[i + 1]) &&
      isOctal(data[i + 2]) &&
      isOctal(data[i + 3])
    ) {
      out[n++] =
        ((data[i + 1]! - 0x30) << 6) | ((data[i + 2]! - 0x30) << 3) | (data[i + 3]! - 0x30);
      i += 3;
    } else out[n++] = byte;
  }
  return out.subarray(0, n);
}

function isOctal(byte: number | undefined): boolean {
  return byte !== undefined && byte >= 0x30 && byte <= 0x37;
}

const OUTPUT = Buffer.from("%output ");
const EXTENDED_OUTPUT = Buffer.from("%extended-output ");
const EXTENDED_SEPARATOR = Buffer.from(" : ");

/**
 * `%output %<pane> <data>` or `%extended-output %<pane> <age> [...] : <data>`; undefined for any
 * other line. tmux 3.2+ sends the extended form to clients with `pause-after` set.
 */
export function parseOutputLine(line: Buffer): { pane: string; data: Buffer } | undefined {
  let rest: Buffer;
  if (line.subarray(0, OUTPUT.length).equals(OUTPUT)) rest = line.subarray(OUTPUT.length);
  else if (line.subarray(0, EXTENDED_OUTPUT.length).equals(EXTENDED_OUTPUT))
    rest = line.subarray(EXTENDED_OUTPUT.length);
  else return undefined;
  const space = rest.indexOf(0x20);
  const pane = (space === -1 ? rest : rest.subarray(0, space)).toString("latin1");
  if (!/^%\d+$/.test(pane)) return undefined;
  if (space === -1) return { pane, data: Buffer.alloc(0) };
  if (line[1] === OUTPUT[1]) return { pane, data: rest.subarray(space + 1) };
  const separator = rest.indexOf(EXTENDED_SEPARATOR, space);
  if (separator === -1) return undefined;
  return { pane, data: rest.subarray(separator + EXTENDED_SEPARATOR.length) };
}

export function tmuxQuote(s: string): string {
  return `'${s.replace(/'/g, "'\\''")}'`;
}

export function unescapeOctal(s: string): string {
  return s.replace(/\\(\\|[0-7]{3})/g, (_m, g: string) =>
    g === "\\" ? "\\" : String.fromCharCode(Number.parseInt(g, 8)),
  );
}

/**
 * a control-channel command line can contain the user's keystrokes
 * (`send-keys -t %1 -l -- 'hunter2'`). Only the verb may ever reach a log or an Error message.
 */
export function verbOf(line: string): string {
  return line.trim().split(/\s+/, 1)[0] || "?";
}

export interface TmuxControlOptions {
  sessionId: string;
  socketName?: string;
  /** The tmux program; `tmux` on PATH when absent. */
  executable?: string;
  log: Logger;
  spawnImpl?: typeof spawn;
  commandTimeoutMs?: number;
  readyTimeoutMs?: number;
}

/** `%end`/`%error` followed by tmux's three guard arguments: time, command number and flags. */
const REPLY_GUARD = /^%(?:end|error) (\S+) (\S+) \S+$/;

/** tmux closes a reply with the time and command number of its own `%begin`. */
function closesBlock(line: string, block: Block): boolean {
  const guard = REPLY_GUARD.exec(line);
  return guard !== null && guard[1] === block.time && guard[2] === block.num;
}

interface Pending {
  resolve: (lines: string[], outputSeq: number) => void;
  reject: (e: Error) => void;
  timer: NodeJS.Timeout;
  verb: string;
}

interface Block {
  lines: string[];
  time: string;
  num: string;
}

export class TmuxControl extends EventEmitter<{
  /** A pane's content changed: new output, or output resuming after `%continue`. */
  output: [string];
  /**
   * The exact bytes a pane's program wrote; only decoded while something listens. `seq` numbers
   * output lines in arrival order, so a `checkpoint` reply can be placed among them.
   */
  bytes: [string, Uint8Array, number];
  /** tmux stopped sending a pane's output to this client; output it skips is not replayed. */
  pause: [string];
  layout: [];
  exit: [];
}> {
  private child: ChildProcess | null = null;
  private queue: Pending[] = [];
  private current: Block | null = null;
  private currentPending: Pending | null = null;
  private started = false;
  private outputSeq = 0;
  private readyTimer: NodeJS.Timeout | null = null;
  alive = false;
  private readonly log: Logger;

  constructor(private readonly opts: TmuxControlOptions) {
    super();
    this.log = opts.log.child({ backend: "tmux", session: opts.sessionId });
  }

  start(): Promise<void> {
    const args = [
      ...(this.opts.socketName ? ["-L", this.opts.socketName] : []),
      // Native/headless services may have a C locale. Preserve UTF-8 and the
      // tab-delimited metadata protocol instead of tmux replacing bytes with _.
      "-u",
      "-C",
      "attach-session",
      "-t",
      this.opts.sessionId,
      "-f",
      "ignore-size",
    ];
    const child = (this.opts.spawnImpl ?? spawn)(this.opts.executable ?? "tmux", args, {
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.child = child;
    this.alive = true;
    const splitter = new ControlLineSplitter();
    let firstBlock: (() => void) | null = null;
    const ready = new Promise<void>((resolve) => {
      firstBlock = resolve;
      // Bounded: a server that never answers must not wedge `connect()` forever.
      this.readyTimer = setTimeout(resolve, this.opts.readyTimeoutMs ?? 2000);
      this.readyTimer.unref?.();
    });
    const settleReady = () => {
      if (this.readyTimer) clearTimeout(this.readyTimer);
      this.readyTimer = null;
      firstBlock?.();
    };
    const onLine = (line: string, raw: Buffer) => {
      // tmux never sends a notification inside an output block (tmux(1), CONTROL MODE), so until
      // its own closing guard every row is reply text -- a captured pane row reading `%exit`,
      // `%output ...` or even a complete `%end 1 2 0` is the user's screen, not a command to
      // this client.
      if (this.current && !closesBlock(line, this.current)) {
        this.current.lines.push(line);
        return;
      }
      if (line.startsWith("%begin")) {
        // `%begin <time> <number> <flags>`; the matching %end repeats the time and number.
        const [, time = "", num = ""] = line.split(" ");
        this.current = { lines: [], time, num };
        this.currentPending = this.started ? (this.queue.shift() ?? null) : null;
        return;
      }
      if (line.startsWith("%end") || line.startsWith("%error")) {
        const block = this.current;
        const pending = this.currentPending;
        this.current = null;
        this.currentPending = null;
        if (!this.started) {
          this.started = true;
          settleReady();
          return;
        }
        if (pending) {
          clearTimeout(pending.timer);
          if (line.startsWith("%error")) {
            // the %error body echoes the command, which can carry keystrokes.
            pending.reject(new Error(`tmux error: ${pending.verb}`));
          } else {
            pending.resolve(
              (block?.lines ?? []).map((l) => (UNESCAPE_OCTAL ? unescapeOctal(l) : l)),
              this.outputSeq,
            );
          }
        }
        return;
      }
      this.dispatchNotification(line, raw);
    };
    child.stdout?.on("data", (chunk: Buffer) => {
      if (!this.alive) return;
      let lines: Buffer[];
      try {
        lines = splitter.push(chunk);
      } catch {
        this.log.warn("tmux control line too long");
        this.stop();
        return;
      }
      for (const raw of lines) {
        if (!this.alive) return;
        // Reply rows are whole lines, so each decodes on its own without splitting a character.
        onLine(raw.toString("utf8"), raw);
      }
    });
    child.stdout?.on("end", () => this.onExit());
    child.stdout?.on("close", () => this.onExit());
    child.on("exit", () => this.onExit());
    // Without this, `spawn("tmux")` on a machine with no tmux emits an 'error' event with no
    // listener, which Node throws as an UNCAUGHT exception and kills the agent.
    child.on("error", (err) => {
      this.log.warn("tmux control spawn failed", { error: safeErrorName(err) });
      settleReady();
      this.onExit();
    });
    // EPIPE on a dead child's stdin must not surface as an unhandled stream error either.
    child.stdin?.on("error", () => undefined);
    child.stderr?.on("data", () => {
      // tmux's stderr can echo the command line we wrote, keystrokes included.
      // Record only that there WAS stderr, never its text.
      this.log.debug("tmux stderr");
    });
    return ready;
  }

  /**
   * True and dispatched if `line` is one of the notification lines tmux can send us
   * (pane output, flow control, a layout change, `%exit`) -- false and untouched otherwise. Only
   * called outside an output block. `raw` is the same line as bytes, for pane output.
   */
  private dispatchNotification(line: string, raw: Buffer): boolean {
    if (line.startsWith("%output ") || line.startsWith("%extended-output ")) {
      const output = parseOutputLine(raw);
      if (!output) return false;
      const seq = ++this.outputSeq;
      this.emit("output", output.pane);
      if (this.listenerCount("bytes") > 0)
        this.emit("bytes", output.pane, unescapeOutput(output.data), seq);
      return true;
    }
    const flow = /^%(pause|continue) (%\d+)$/.exec(line);
    if (flow) {
      if (flow[1] === "pause") this.emit("pause", flow[2]!);
      else this.emit("output", flow[2]!);
      return true;
    }
    if (
      // M-5 (spec errata E-3): `session-changed` fires on our OWN attach and is not in spec
      // §8.11's notification list, but tmux does send it, and dropping it into a reply would be
      // just as wrong as dropping any other layout notification -- kept deliberately, one debounced
      // refresh per new control client is the cost.
      /^%(layout-change|window-add|window-close|window-renamed|unlinked-window-|session-changed|session-renamed|sessions-changed)/.test(
        line,
      )
    ) {
      this.emit("layout");
      return true;
    }
    if (line.startsWith("%exit")) {
      this.onExit();
      return true;
    }
    return false;
  }

  command(line: string): Promise<string[]> {
    return this.send([line]).then(([reply]) => reply!.lines);
  }

  /**
   * Runs `commands` as one tmux command list, so no pane output is parsed between them, and
   * reports how many output lines arrived before the first reply ended (`outputSeq`) and before
   * the commands were sent (`sentSeq`). A pane's bytes with a larger `seq` than `outputSeq` came
   * after the reply. tmux only keeps that cut exact while no other pane's output is queued ahead
   * of the reply, so a caller treats another pane's output in (`sentSeq`, `outputSeq`] as unsafe.
   */
  async checkpoint(
    commands: string[],
  ): Promise<{ replies: string[][]; sentSeq: number; outputSeq: number }> {
    const sentSeq = this.outputSeq;
    const replies = await this.send(commands);
    return { replies: replies.map((r) => r.lines), sentSeq, outputSeq: replies[0]!.outputSeq };
  }

  /** One reply per command; tmux answers each command of a `;` list in its own block. */
  private send(commands: string[]): Promise<{ lines: string[]; outputSeq: number }[]> {
    if (commands.length === 0 || !this.alive || !this.child?.stdin) {
      return Promise.reject(new Error("tmux control exited"));
    }
    const pendings: Pending[] = [];
    const replies = commands.map(
      (command) =>
        new Promise<{ lines: string[]; outputSeq: number }>((resolve, reject) => {
          const timer = setTimeout(() => {
            reject(new Error(`tmux command timeout: ${verbOf(command)}`));
            // Replies are correlated by FIFO. Dropping a timed-out request while
            // keeping the client alive can give its late reply to another request.
            // Retire this client; backend discovery reattaches to the running session.
            this.stop();
          }, this.opts.commandTimeoutMs ?? 5000);
          // M-1: every other timer on this branch is `unref`'d; without this, a `capture-pane` in
          // flight when the process is Ctrl-C'd keeps the event loop alive for up to 5 s.
          timer.unref?.();
          pendings.push({
            resolve: (lines, outputSeq) => resolve({ lines, outputSeq }),
            reject,
            timer,
            verb: verbOf(command),
          });
        }),
    );
    this.queue.push(...pendings);
    try {
      this.child.stdin.write(`${commands.join(" ; ")}\n`);
    } catch {
      for (const pending of pendings) {
        clearTimeout(pending.timer);
        pending.reject(new Error("tmux control exited"));
      }
      this.queue = this.queue.filter((p) => !pendings.includes(p));
    }
    return Promise.all(replies);
  }

  /** Idempotent: safe to call from `close()`, from `onExit`, and again by a caller. */
  stop(): void {
    if (this.child) {
      try {
        this.child.stdin?.write("detach-client\n");
      } catch {
        // the child is already gone; nothing to detach
      }
      this.child.kill();
    }
    this.onExit();
  }

  private onExit(): void {
    if (!this.alive) return;
    this.alive = false;
    if (this.readyTimer) clearTimeout(this.readyTimer);
    this.readyTimer = null;
    for (const p of [this.currentPending, ...this.queue]) {
      if (!p) continue;
      clearTimeout(p.timer);
      p.reject(new Error("tmux control exited"));
    }
    this.queue = [];
    this.currentPending = null;
    this.emit("exit");
  }
}
