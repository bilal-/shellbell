import { readFileSync } from "node:fs";
import { PassThrough } from "node:stream";
import { describe, expect, it } from "vitest";
import { TmuxControl, tmuxQuote, unescapeOctal, verbOf } from "../src/backends/tmux/control.js";
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
    stdout.write("%begin 2 PRIVATE_BEGIN_SENTINEL 0\n%3\tmain\n%end 3 PRIVATE_END_SENTINEL 0\n");
    expect(await response).toEqual(["%3\tmain"]);
    expect(JSON.stringify(warnings)).not.toContain("SENTINEL");
    expect(warnings).toHaveLength(1);
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

  it("warns on a %begin/%end number mismatch but still resolves the pending command by FIFO", async () => {
    const { spawnImpl, stdout } = fakeSpawn();
    const warns: [string, Record<string, unknown> | undefined][] = [];
    const fakeLog: Logger = {
      debug: () => undefined,
      info: () => undefined,
      warn: (m, f) => warns.push([m, f]),
      error: () => undefined,
      child: () => fakeLog,
    };
    const c = new TmuxControl({ sessionId: "$0", log: fakeLog, spawnImpl });
    const started = c.start();
    stdout.write("%begin 1 0 0\n%end 1 0 0\n");
    await started;

    const p = c.command("list-panes -a");
    await flush();
    // The reply's %end carries a different command number (field 2; field 1 is the time) than
    // its %begin -- a desync, not a dropped reply -- so the command still resolves via the FIFO
    // queue, but a warn is logged.
    stdout.write("%begin 1700000000 7 0\n%3\tmain\n%end 1700000001 8 0\n");
    expect(await p).toEqual(["%3\tmain"]);
    expect(warns).toEqual([["tmux %begin/%end number mismatch", { begin: "7", end: "8" }]]);
    c.stop();
  });

  it("M-2: dispatches a notification that arrives inside an open %begin/%end block, without corrupting the reply", async () => {
    const { spawnImpl, stdout } = fakeSpawn();
    const c = new TmuxControl({ sessionId: "$0", log, spawnImpl });
    const outputs: string[] = [];
    let layouts = 0;
    c.on("output", (p) => outputs.push(p));
    c.on("layout", () => layouts++);
    const started = c.start();
    stdout.write("%begin 1 0 0\n%end 1 0 0\n");
    await started;

    const p = c.command("list-panes -a");
    await flush();
    // A genuine reply-block data row can itself start with a pane id (`%3\tmain`) -- interleaving
    // a REAL notification inside the SAME open block must still be recognised as a notification
    // (not swallowed as a third data row), and must not appear in the resolved reply.
    stdout.write("%begin 2 1 0\n%3\tmain\n%output %3 hello\n%layout-change @1 xyz\n%end 2 1 0\n");
    expect(await p).toEqual(["%3\tmain"]);
    expect(outputs).toEqual(["%3"]);
    expect(layouts).toBe(1);
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
