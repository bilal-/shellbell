import { readFileSync } from "node:fs";
import { PassThrough } from "node:stream";
import { describe, expect, it } from "vitest";
import {
  ControlLineSplitter,
  MAX_CONTROL_LINE_BYTES,
  parseOutputLine,
  TmuxControl,
  tmuxQuote,
  unescapeOctal,
  unescapeOutput,
  verbOf,
} from "../src/backends/tmux/control.js";
import { createLogger, type Logger } from "../src/log.js";

/** Lets the PassThrough streams below deliver their queued `data`/`line` events. */
const flush = () => new Promise((r) => setImmediate(r));

function fakeSpawn() {
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  const written: string[] = [];
  stdin.on("data", (d) => written.push(String(d)));
  const listeners = new Map<string, ((...a: unknown[]) => void)[]>();
  const child = {
    stdin,
    stdout,
    stderr,
    pid: 1,
    kill: () => stdout.end(),
    on(event: string, fn: (...a: unknown[]) => void) {
      listeners.set(event, [...(listeners.get(event) ?? []), fn]);
      return child;
    },
  } as unknown as import("node:child_process").ChildProcess & {
    emitFake(event: string, ...args: unknown[]): void;
  };
  (child as unknown as { emitFake: (e: string, ...a: unknown[]) => void }).emitFake = (e, ...a) => {
    for (const fn of listeners.get(e) ?? []) fn(...a);
  };
  const spawnImpl = (() => child) as unknown as typeof import("node:child_process").spawn;
  return { spawnImpl, stdout, stderr, written, child };
}

const log = createLogger({ stdout: false });

it("does not log arbitrary tmux control sequence tokens", async () => {
  const { spawnImpl, stdout } = fakeSpawn();
  const warnings: unknown[] = [];
  const privateLog: Logger = {
    ...log,
    child: () => privateLog,
    warn: (message, fields) => {
      warnings.push({ message, fields });
    },
  };
  const control = new TmuxControl({ sessionId: "$0", log: privateLog, spawnImpl });
  try {
    const started = control.start();
    stdout.write("%begin 1 0 0\n%end 1 0 0\n");
    await started;
    const response = control.command("list-panes -a");
    stdout.write(
      "%begin 2 PRIVATE_BEGIN_SENTINEL 0\n%3\tmain\n%end 3 PRIVATE_END_SENTINEL 0\n" +
        "%end 2 PRIVATE_BEGIN_SENTINEL 0\n",
    );
    expect(await response).toEqual(["%3\tmain", "%end 3 PRIVATE_END_SENTINEL 0"]);
    expect(JSON.stringify(warnings)).not.toContain("SENTINEL");
  } finally {
    control.stop();
  }
});

describe("tmuxQuote / unescapeOctal / verbOf", () => {
  it("quotes for tmux and unescapes control-mode octal", () => {
    expect(tmuxQuote("a b")).toBe("'a b'");
    expect(tmuxQuote("it's")).toBe("'it'\\''s'");
    expect(unescapeOctal("\\033[31mred\\033[0m \\\\ x")).toBe("\x1b[31mred\x1b[0m \\ x");
  });

  it("verbOf keeps only the command name, never the arguments (spec 8.10)", () => {
    expect(verbOf("send-keys -t %1 -l -- 'hunter2'")).toBe("send-keys");
    expect(verbOf("capture-pane -p -e -N -t %1")).toBe("capture-pane");
    expect(verbOf("")).toBe("?");
  });
});

describe("TmuxControl", () => {
  it("rejects reuse after a timeout instead of assigning a late reply to another pane", async () => {
    const { spawnImpl, stdout, child } = fakeSpawn();
    // A terminated client can still deliver already-buffered stdout.
    child.kill = () => true;
    const c = new TmuxControl({ sessionId: "$0", log, spawnImpl, commandTimeoutMs: 20 });
    try {
      const started = c.start();
      stdout.write("%begin 1 0 0\n%end 1 0 0\n");
      await started;
      await expect(c.command("capture-pane -p -t %1")).rejects.toThrow(
        "tmux command timeout: capture-pane",
      );
      const following = expect(c.command("capture-pane -p -t %2")).rejects.toThrow(
        "tmux control exited",
      );
      stdout.write(
        "%begin 2 1 0\nFIRST_PANE_LATE_RESPONSE\n%end 2 1 0\n" +
          "%begin 3 2 0\nSECOND_PANE_RESPONSE\n%end 3 2 0\n",
      );
      await following;
    } finally {
      c.stop();
      stdout.end();
    }
  });

  it("rejects queued requests when an in-progress reply times out", async () => {
    const { spawnImpl, stdout } = fakeSpawn();
    const c = new TmuxControl({ sessionId: "$0", log, spawnImpl, commandTimeoutMs: 20 });
    try {
      const started = c.start();
      stdout.write("%begin 1 0 0\n%end 1 0 0\n");
      await started;
      const first = c.command("capture-pane -p -t %1");
      stdout.write("%begin 2 1 0\nPARTIAL_FIRST_PANE\n");
      const second = c.command("capture-pane -p -t %2");
      expect(await Promise.allSettled([first, second])).toEqual([
        { status: "rejected", reason: new Error("tmux command timeout: capture-pane") },
        { status: "rejected", reason: new Error("tmux control exited") },
      ]);
      await expect(c.command("list-panes -a")).rejects.toThrow("tmux control exited");
    } finally {
      c.stop();
    }
  });

  it("parses %begin/%end replies in order, emits %output and layout events, handles %error", async () => {
    const { spawnImpl, stdout, written } = fakeSpawn();
    const c = new TmuxControl({ sessionId: "$0", log, spawnImpl });
    const outputs: string[] = [];
    let layouts = 0;
    c.on("output", (p) => outputs.push(p));
    c.on("layout", () => layouts++);
    const started = c.start();
    stdout.write("%begin 1 0 0\n%end 1 0 0\n");
    await started;

    const p1 = c.command("list-panes -a");
    const p2 = c.command("display-message -p x");
    // PassThrough delivers `data` asynchronously: without this the array is still empty.
    await flush();
    expect(written.join("")).toBe("list-panes -a\ndisplay-message -p x\n");

    stdout.write(
      "%output %3 hello\n%begin 2 1 0\n%3\tmain\n%end 2 1 0\n%layout-change @1 xyz\n%begin 3 2 0\n%error 3 2 0\n",
    );
    expect(await p1).toEqual(["%3\tmain"]);
    await expect(p2).rejects.toThrow(/tmux error/);
    expect(outputs).toEqual(["%3"]);
    expect(layouts).toBe(1);
    c.stop();
  });

  it("places a checkpoint's first reply among output lines and answers each listed command", async () => {
    const { spawnImpl, stdout, written } = fakeSpawn();
    const c = new TmuxControl({ sessionId: "$0", log, spawnImpl });
    const seqs: [string, string, number][] = [];
    c.on("bytes", (pane, data, seq) => seqs.push([pane, Buffer.from(data).toString(), seq]));
    const started = c.start();
    stdout.write("%begin 1 0 0\n%end 1 0 0\n%output %1 early\n");
    await started;
    await flush();

    const checkpoint = c.checkpoint(["capture-pane -p -t %1", "display -p -t %1 x"]);
    await flush();
    expect(written.join("")).toBe("capture-pane -p -t %1 ; display -p -t %1 x\n");
    stdout.write(
      "%output %2 other\n%output %1 before\n%begin 2 1 0\nrow\n%end 2 1 0\n" +
        "%output %1 after\n%begin 3 1 0\n0 24\n%end 3 1 0\n",
    );
    expect(await checkpoint).toEqual({ replies: [["row"], ["0 24"]], sentSeq: 1, outputSeq: 3 });
    expect(seqs).toEqual([
      ["%1", "early", 1],
      ["%2", "other", 2],
      ["%1", "before", 3],
      ["%1", "after", 4],
    ]);
    c.stop();
  });

  it("keeps an %end from another reply as text until this reply's own %end", async () => {
    const { spawnImpl, stdout } = fakeSpawn();
    const c = new TmuxControl({ sessionId: "$0", log, spawnImpl });
    const started = c.start();
    stdout.write("%begin 1 0 0\n%end 1 0 0\n");
    await started;

    const p = c.command("list-panes -a");
    await flush();
    // tmux repeats the %begin time (field 1) and command number (field 2) in its %end, so a
    // guard with different fields came from the pane's text, not from tmux.
    stdout.write("%begin 1700000000 7 0\n%3\tmain\n%end 1700000001 8 0\n%end 1700000000 7 0\n");
    expect(await p).toEqual(["%3\tmain", "%end 1700000001 8 0"]);
    c.stop();
  });

  it("keeps captured terminal rows that look like notifications or guards inside the reply", async () => {
    const { spawnImpl, stdout } = fakeSpawn();
    const c = new TmuxControl({ sessionId: "$0", log, spawnImpl });
    const outputs: string[] = [];
    let layouts = 0;
    let exits = 0;
    c.on("output", (p) => outputs.push(p));
    c.on("layout", () => layouts++);
    c.on("exit", () => exits++);
    const started = c.start();
    stdout.write("%begin 1 0 0\n%end 1 0 0\n");
    await started;

    const p = c.command("capture-pane -p -e -N -t %3");
    await flush();
    // tmux never sends a notification inside an output block, so every row here is pane text
    // the user can type: none of it may end the reply, emit an event, or retire the client.
    const rows = [
      "%3\tmain",
      "%exit",
      "%output %3 hello",
      "%layout-change @1 xyz",
      "%begin",
      "%end",
      "%error: build failed",
      "%end-of-file",
    ];
    stdout.write(`%begin 2 1 0\n${rows.join("\n")}\n%end 2 1 0\n`);
    expect(await p).toEqual(rows);

    // A complete guard-shaped row from another reply is still the user's screen: only the
    // %end carrying this reply's own time and command number closes it.
    const q = c.command("capture-pane -p -e -N -t %3");
    await flush();
    const guarded = ["%end 1 0 0", "%error 9 9 1", "%exit"];
    stdout.write(`%begin 3 2 1\n${guarded.join("\n")}\n%end 3 2 1\n`);
    expect(await q).toEqual(guarded);
    expect(outputs).toEqual([]);
    expect(layouts).toBe(0);
    expect(exits).toBe(0);
    expect(c.alive).toBe(true);

    stdout.write("%output %3 later\n%exit\n");
    await flush();
    expect(outputs).toEqual(["%3"]);
    expect(exits).toBe(1);
    c.stop();
  });

  it("M-1: the per-command timeout timer is unref'd (never keeps the event loop alive)", async () => {
    const { spawnImpl, stdout } = fakeSpawn();
    const c = new TmuxControl({ sessionId: "$0", log, spawnImpl, commandTimeoutMs: 50 });
    const started = c.start();
    stdout.write("%begin 1 0 0\n%end 1 0 0\n");
    await started;

    const realSetTimeout = global.setTimeout;
    let unrefCalled = false;
    global.setTimeout = ((fn: (...a: unknown[]) => void, ms?: number, ...rest: unknown[]) => {
      const t = realSetTimeout(fn, ms, ...rest);
      const originalUnref = t.unref.bind(t);
      t.unref = () => {
        unrefCalled = true;
        return originalUnref();
      };
      return t;
    }) as typeof setTimeout;
    let p: Promise<string[]>;
    try {
      p = c.command("list-panes -a");
    } finally {
      global.setTimeout = realSetTimeout;
    }
    p.catch(() => undefined);
    expect(unrefCalled).toBe(true);
    c.stop();
  });

  it("never puts a command's arguments into a rejection message (spec 8.10)", async () => {
    const { spawnImpl, stdout } = fakeSpawn();
    const c = new TmuxControl({ sessionId: "$0", log, spawnImpl, commandTimeoutMs: 20 });
    const started = c.start();
    stdout.write("%begin 1 0 0\n%end 1 0 0\n");
    await started;
    const p = c.command("send-keys -t %1 -l -- 'hunter2'");
    await expect(p).rejects.toThrow(/tmux command timeout: send-keys/);
    await expect(p).rejects.not.toThrow(/hunter2/);
    c.stop();
  });

  it("rejects pending commands and emits exit when the process ends", async () => {
    const { spawnImpl, stdout } = fakeSpawn();
    const c = new TmuxControl({ sessionId: "$0", log, spawnImpl });
    const started = c.start();
    stdout.write("%begin 1 0 0\n%end 1 0 0\n");
    await started;
    let exited = 0;
    c.on("exit", () => exited++);
    const p = c.command("list-panes -a");
    stdout.write("%exit\n");
    stdout.end();
    await expect(p).rejects.toThrow(/exited/);
    await flush();
    expect(exited).toBe(1);
    expect(c.alive).toBe(false);
    // Idempotent: a second stop must not emit a second `exit`.
    c.stop();
    expect(exited).toBe(1);
  });

  it("survives a spawn error instead of throwing an uncaught 'error' event", async () => {
    const { spawnImpl, child } = fakeSpawn();
    const c = new TmuxControl({ sessionId: "$0", log, spawnImpl, readyTimeoutMs: 20 });
    let exited = 0;
    c.on("exit", () => exited++);
    const started = c.start();
    (child as unknown as { emitFake: (e: string, ...a: unknown[]) => void }).emitFake(
      "error",
      Object.assign(new Error("spawn tmux ENOENT"), { name: "Error" }),
    );
    await started;
    expect(c.alive).toBe(false);
    expect(exited).toBe(1);
    await expect(c.command("list-panes -a")).rejects.toThrow(/exited/);
  });

  it("replays the recorded spike transcript and reports what it parsed", async () => {
    const { spawnImpl, stdout } = fakeSpawn();
    const c = new TmuxControl({ sessionId: "$0", log, spawnImpl });
    const outputs: string[] = [];
    let layouts = 0;
    let exits = 0;
    c.on("output", (p) => outputs.push(p));
    c.on("layout", () => layouts++);
    c.on("exit", () => exits++);
    const started = c.start();
    const text = readFileSync(new URL("./fixtures/tmux-transcript.txt", import.meta.url), "utf8");
    stdout.write(text);
    await started;
    await flush();

    // the parser is proven against the RECORDED transcript, not just synthetic lines.
    const beginCount = text.split("\n").filter((l) => l.startsWith("%begin")).length;
    const endCount = text.split("\n").filter((l) => l.startsWith("%end")).length;
    expect(beginCount).toBe(29);
    expect(endCount).toBe(29); // balanced: every reply block closed
    expect(text).not.toMatch(/^%error/m); // the recorded run had zero errors
    expect(outputs.length).toBeGreaterThan(0);
    expect(new Set(outputs)).toEqual(new Set(["%0"])); // the spike had exactly one pane
    expect(layouts).toBeGreaterThan(0);
    // The transcript ends with %exit; the client must have torn itself down.
    expect(exits).toBe(1);
    expect(c.alive).toBe(false);
    // UNESCAPE_OCTAL=false is load-bearing: capture-pane replies carry a RAW 0x1B.
    expect(text).toContain("\x1b[");
    c.stop();
  });
});

describe("byte-exact control output", () => {
  async function started() {
    const fake = fakeSpawn();
    const control = new TmuxControl({ sessionId: "$0", log, spawnImpl: fake.spawnImpl });
    const ready = control.start();
    fake.stdout.write("%begin 1 0 0\n%end 1 0 0\n");
    await ready;
    return { ...fake, control };
  }

  it("keeps a UTF-8 character split across reads and across output lines", async () => {
    const { stdout, control } = await started();
    const bytes: [string, number[]][] = [];
    control.on("bytes", (pane, data) => bytes.push([pane, [...data]]));
    try {
      const line = Buffer.from("%output %1 a界\\015\\012\n");
      // Split inside the three-byte 界 and again inside the escape.
      stdout.write(line.subarray(0, 13));
      stdout.write(line.subarray(13, 17));
      stdout.write(line.subarray(17));
      // A character split between two %output lines arrives as two exact byte runs.
      const e = Buffer.from("é");
      stdout.write(
        Buffer.concat([Buffer.from("%output %1 "), e.subarray(0, 1), Buffer.from("\n")]),
      );
      stdout.write(Buffer.concat([Buffer.from("%output %1 "), e.subarray(1), Buffer.from("\n")]));
      await flush();
      expect(bytes).toEqual([
        ["%1", [...Buffer.from("a界\r\n")]],
        ["%1", [e[0]!]],
        ["%1", [e[1]!]],
      ]);
      expect(Buffer.concat(bytes.slice(1).map(([, d]) => Buffer.from(d))).toString()).toBe("é");
    } finally {
      control.stop();
    }
  });

  it("restores escaped backslashes, control bytes and raw high bytes exactly", () => {
    expect([...unescapeOutput(Buffer.from("\\\\\\033[1m\\000x\\7"))]).toEqual([
      0x5c, 0x1b, 0x5b, 0x31, 0x6d, 0x00, 0x78, 0x5c, 0x37,
    ]);
    expect([...unescapeOutput(Buffer.from([0xff, 0x80]))]).toEqual([0xff, 0x80]);
  });

  it("reads %extended-output and flow control as change hints for that pane", async () => {
    const { stdout, control } = await started();
    const seen: string[] = [];
    control.on("output", (pane) => seen.push(`output ${pane}`));
    control.on("pause", (pane) => seen.push(`pause ${pane}`));
    control.on("bytes", (pane, data) => seen.push(`bytes ${pane} ${Buffer.from(data)}`));
    try {
      stdout.write("%extended-output %2 15 : hi : there\\012\n");
      stdout.write("%pause %2\n%continue %2\n");
      await flush();
      expect(seen).toEqual(["output %2", "bytes %2 hi : there\n", "pause %2", "output %2"]);
    } finally {
      control.stop();
    }
  });

  it("parses only well-formed output lines", () => {
    expect(parseOutputLine(Buffer.from("%output %3 x y"))).toEqual({
      pane: "%3",
      data: Buffer.from("x y"),
    });
    expect(parseOutputLine(Buffer.from("%output %3"))).toEqual({
      pane: "%3",
      data: Buffer.alloc(0),
    });
    expect(parseOutputLine(Buffer.from("%output 3 x"))).toBeUndefined();
    expect(parseOutputLine(Buffer.from("%extended-output %3 10 x"))).toBeUndefined();
    expect(parseOutputLine(Buffer.from("%outputs %3 x"))).toBeUndefined();
  });

  it("keeps reply rows that look like output as reply text", async () => {
    const { stdout, control } = await started();
    const bytes: unknown[] = [];
    control.on("bytes", (...args) => bytes.push(args));
    try {
      const reply = control.command("capture-pane -p");
      stdout.write("%begin 2 1 1\n%output %1 not output\r\n%end 2 1 1\n");
      expect(await reply).toEqual(["%output %1 not output"]);
      expect(bytes).toEqual([]);
    } finally {
      control.stop();
    }
  });

  it("retires the client instead of buffering an endless line", async () => {
    const { stdout, control } = await started();
    let exited = false;
    control.on("exit", () => {
      exited = true;
    });
    stdout.write(Buffer.alloc(MAX_CONTROL_LINE_BYTES + 1, 0x61));
    await flush();
    expect(exited).toBe(true);
    expect(control.alive).toBe(false);
  });

  it("splits lines without decoding them", () => {
    const splitter = new ControlLineSplitter();
    expect(splitter.push(Buffer.from([0x61, 0xe7]))).toEqual([]);
    expect(splitter.push(Buffer.from([0x95, 0x8c, 0x0a, 0x62]))).toEqual([Buffer.from("a界")]);
    expect(splitter.push(Buffer.from("\r\n"))).toEqual([Buffer.from("b")]);
  });
});
