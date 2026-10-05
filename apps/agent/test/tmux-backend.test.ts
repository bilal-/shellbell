import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";
import { TmuxBackend } from "../src/backends/tmux/backend.js";
import type { TmuxControl } from "../src/backends/tmux/control.js";
import { SessionGone } from "../src/backends/types.js";
import { createLogger } from "../src/log.js";
import { waitFor } from "./fakes/wait.js";

class FakeControl extends EventEmitter<{ output: [string]; layout: []; exit: [] }> {
  alive = true;
  commands: string[] = [];
  screen = ["\x1b[1mhello\x1b[0m", "world", ""];
  history = ["h1", "h2", "h3"];
  historySize = 3;
  historyLimit = 3;
  alternate = false;
  afterCommand?: (line: string) => void;
  constructor(readonly sessionId: string) {
    super();
  }
  async start(): Promise<void> {}
  stop(): void {
    this.alive = false;
  }
  async command(line: string): Promise<string[]> {
    this.commands.push(line);
    if (line.startsWith("list-panes")) {
      return [
        [
          "%1",
          "$0",
          "main",
          "@0",
          "0",
          "zsh",
          "0",
          "host",
          "/tmp",
          "10",
          "3",
          "1",
          "1",
          "3",
          "0",
          "2",
          "0",
          "zsh",
        ].join("\t"),
        [
          "%2",
          "$0",
          "main",
          "@1",
          "1",
          "build",
          "0",
          "host",
          "/tmp",
          "10",
          "3",
          "1",
          "0",
          "0",
          "0",
          "0",
          "0",
          "make",
        ].join("\t"),
      ];
    }
    if (line.startsWith("list-clients")) return ["$0\t1", "$0\t0"];
    if (line.startsWith("display-message"))
      return [
        line.includes("history_limit")
          ? `4\t1\t${this.historySize}\t10\t3\t${this.historyLimit}\t${this.alternate ? 1 : 0}`
          : `4\t1\t${this.historySize}\t10\t3`,
      ];
    if (line.startsWith("capture-pane") && line.includes("-S")) {
      const m = /-S (-?\d+) -E (-?\d+)/.exec(line) as RegExpExecArray;
      const s = Number(m[1]);
      const e = Number(m[2]);
      return this.history.slice(this.history.length + s, this.history.length + e + 1);
    }
    if (line.startsWith("capture-pane")) return this.screen;
    if (line.startsWith("send-keys")) return [];
    if (
      line.startsWith("new-window") ||
      line.startsWith("new-session") ||
      line.startsWith("split-window")
    ) {
      return ["%9"];
    }
    throw new Error(`unexpected ${line.split(" ")[0]}`);
  }
}

const log = createLogger({ stdout: false });
const exec = async (args: string[]) => (args[0] === "-V" ? "tmux 3.4\n" : "$0\n");
const factory = (sink?: FakeControl[]) => (sid: string) => {
  const c = new FakeControl(sid);
  sink?.push(c);
  return c as unknown as TmuxControl;
};

it("creates and attaches the first tmux session without an existing server", async () => {
  let running = false;
  const execute = vi.fn(async (args: string[]) => {
    if (args[0] === "-V") return "tmux 3.4\n";
    if (args[0] === "new-session") {
      running = true;
      return "%1\n";
    }
    if (args[0] === "list-sessions" && running) return "$0\n";
    throw new Error("no server running");
  });
  const backend = new TmuxBackend({ log, execImpl: execute, controlFactory: factory() });
  try {
    expect(await backend.createFirstSession()).toBe("%1");
    expect(backend.isConnected).toBe(true);
    expect((await backend.listSessions()).some((session) => session.id === "%1")).toBe(true);
    expect(execute).toHaveBeenCalledWith(["new-session", "-d", "-P", "-F", "#{pane_id}"]);
    expect(execute.mock.calls.filter(([args]) => args[0] === "new-session")).toHaveLength(1);
  } finally {
    await backend.close();
  }
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe("TmuxBackend", () => {
  it("exposes local process facts with distinct pane labels", async () => {
    const b = new TmuxBackend({ log, hostname: "host", execImpl: exec, controlFactory: factory() });
    await b.connect();
    try {
      const a = await b.notificationFacts("%1");
      const other = await b.notificationFacts("%2");
      expect(a).toMatchObject({ sessionId: "%1", cwd: "/tmp", locality: "local", shell: "zsh" });
      expect(a?.sessionLabel).not.toBe(other?.sessionLabel);
      expect(await b.notificationFacts("missing")).toBeUndefined();
    } finally {
      await b.close();
    }
  });
  it("detects version and server, and orders versions like doctor's parseTmuxVersion", async () => {
    expect(await TmuxBackend.detect(exec)).toMatchObject({ ok: true, version: "3.4" });
    const old = await TmuxBackend.detect(async (a) => (a[0] === "-V" ? "tmux 3.1\n" : "$0\n"));
    expect(old).toMatchObject({ ok: false });
    expect(old.reason).toMatch(/3\.2\+ required/);
    // Regression: parseFloat("3.10") === 3.1 would wrongly reject a NEWER tmux.
    expect(
      await TmuxBackend.detect(async (a) => (a[0] === "-V" ? "tmux 3.10\n" : "$0\n")),
    ).toMatchObject({ ok: true });
    expect(
      await TmuxBackend.detect(async (a) => {
        if (a[0] === "-V") return "tmux 3.4\n";
        throw new Error("no server");
      }),
    ).toMatchObject({ ok: false, reason: "no tmux server running" });
    expect(
      await TmuxBackend.detect(async () => {
        throw new Error("ENOENT");
      }),
    ).toMatchObject({ ok: false, reason: "tmux not found" });
  });

  it("lists panes with titles, focus from non-control clients, window ids for de-dup", async () => {
    const controls: FakeControl[] = [];
    const b = new TmuxBackend({
      log,
      hostname: "host",
      execImpl: exec,
      controlFactory: factory(controls),
    });
    await b.connect();
    expect(b.isConnected).toBe(true);
    const list = await b.listSessions();
    expect(list.map((s) => [s.id, s.title, s.cwd, s.isFocusedOnMac, s.windowId, s.tabId])).toEqual([
      ["%1", "main:0.0", "/tmp", true, "$0", "@0"],
      ["%2", "build", "/tmp", false, "$0", "@1"],
    ]);
    expect(list.every((s) => s.state === "unknown")).toBe(true);
    // de-dup hook: the registry calls this with the NATIVE id and compares to `@N`.
    expect(b.tmuxWindowIdOf("%2")).toBe("@1");
    expect(b.tmuxWindowIdOf("%nope")).toBeUndefined();
    expect(b.capabilities).toEqual({
      subscribe: true,
      prompts: false,
      createSession: true,
      focus: false,
      history: true,
      absoluteLines: false,
    });
    await b.close();
    expect(b.isConnected).toBe(false);
    // close() is idempotent and stops every control client.
    await b.close();
    expect(controls.every((c) => !c.alive)).toBe(true);
  });

  it("getScreen parses SGR rows over the command channel and reports history_size", async () => {
    const b = new TmuxBackend({ log, hostname: "host", execImpl: exec, controlFactory: factory() });
    await b.connect();
    const s = await b.getScreen("%1");
    expect(s.lines[0]).toEqual({ r: [{ t: "hello", b: true }] });
    expect(s.lines[1]).toEqual({ r: [{ t: "world" }] });
    expect(s.rows).toBe(3);
    expect(s.cols).toBe(10);
    expect(s.cursor).toEqual({ x: 4, y: 1 });
    expect(s.scrollbackTotal).toBe(3);
    await b.close();
  });

  it("history range arithmetic uses the tracker's reported value", async () => {
    const b = new TmuxBackend({ log, hostname: "host", execImpl: exec, controlFactory: factory() });
    await b.connect();
    b.setReported("%1", 3);
    const h = await b.getHistory("%1", 3, 2);
    expect(h.lines.map((l) => l.r[0]?.t)).toEqual(["h2", "h3"]);
    expect(h.oldestAvailable).toBe(0);
    await b.close();
  });

  it("anchors an explicitly requested history page to its captured facts", async () => {
    const controls: FakeControl[] = [];
    const b = new TmuxBackend({
      log,
      hostname: "host",
      execImpl: exec,
      controlFactory: factory(controls),
    });
    await b.connect();
    const screen = await b.getScreen("%1", { history: true });
    expect(screen.historyCapture).toBeDefined();
    b.setReported("%1", 500);
    await expect(
      b.getHistoryPage("%1", {
        capture: screen.historyCapture!,
        reported: 50,
        before: 50,
        count: 2,
        signal: new AbortController().signal,
      }),
    ).resolves.toEqual({
      status: "page",
      from: 48,
      to: 50,
      oldestAvailable: 47,
      lines: [{ r: [{ t: "h2" }] }, { r: [{ t: "h3" }] }],
    });
    expect(controls[0]?.commands.some((line) => line.includes("-S -2 -E -1"))).toBe(true);
    await b.close();
  });

  it("M-7: getHistory with no setReported baseline returns empty rather than guessed lines", async () => {
    const control = new FakeControl("$0");
    const b = new TmuxBackend({
      log,
      hostname: "host",
      execImpl: exec,
      controlFactory: () => control as unknown as TmuxControl,
    });
    await b.connect();
    // setReported("%1", ...) never ran for this pane -- the tracker only calls it after actually
    // processing a screen frame for it (e.g. the phone requested history for a session it has
    // never viewed).
    const before = control.commands.length;
    const h = await b.getHistory("%1", 3, 2);
    expect(h).toEqual({ lines: [], oldestAvailable: 0 });
    // No `display-message`/`capture-pane` round trip either -- there is nothing honest to compute.
    expect(control.commands.length).toBe(before);
    await b.close();
  });

  it("rejects a reported origin below captured history without spending the capture", async () => {
    const b = new TmuxBackend({ log, hostname: "host", execImpl: exec, controlFactory: factory() });
    await b.connect();
    const capture = (await b.getScreen("%1", { history: true })).historyCapture!;
    await expect(
      b.getHistoryPage("%1", {
        capture,
        reported: 2,
        before: 2,
        count: 1,
        signal: new AbortController().signal,
      }),
    ).resolves.toEqual({ status: "unavailable", reason: "unanchored" });
    await expect(
      b.getHistoryPage("%1", {
        capture,
        reported: 3,
        before: 3,
        count: 1,
        signal: new AbortController().signal,
      }),
    ).resolves.toMatchObject({ status: "page", from: 2, to: 3 });
    await b.close();
  });

  it("lets cancellation win when the post-page facts command settles", async () => {
    const controls: FakeControl[] = [];
    const b = new TmuxBackend({
      log,
      hostname: "host",
      execImpl: exec,
      controlFactory: factory(controls),
    });
    await b.connect();
    const capture = (await b.getScreen("%1", { history: true })).historyCapture!;
    const controller = new AbortController();
    const control = controls[0]!;
    const original = control.command.bind(control);
    let historyFactReads = 0;
    control.command = (line) => {
      if (!line.includes("history_limit")) return original(line);
      const response = Promise.resolve(["4\t1\t3\t10\t3\t3\t0"]);
      if (++historyFactReads === 2) response.then(() => queueMicrotask(() => controller.abort()));
      return response;
    };
    await expect(
      b.getHistoryPage("%1", {
        capture,
        reported: 3,
        before: 3,
        count: 1,
        signal: controller.signal,
      }),
    ).resolves.toEqual({ status: "cancelled" });
    await b.close();
  });

  it("lets cancellation win when a boundary's post-facts command settles", async () => {
    const controls: FakeControl[] = [];
    const b = new TmuxBackend({
      log,
      hostname: "host",
      execImpl: exec,
      controlFactory: factory(controls),
    });
    await b.connect();
    const capture = (await b.getScreen("%1", { history: true })).historyCapture!;
    const controller = new AbortController();
    const control = controls[0]!;
    const original = control.command.bind(control);
    let historyFactReads = 0;
    control.command = (line) => {
      if (!line.includes("history_limit")) return original(line);
      const response = Promise.resolve(["4\t1\t3\t10\t3\t3\t0"]);
      if (++historyFactReads === 2) response.then(() => queueMicrotask(() => controller.abort()));
      return response;
    };
    await expect(
      b.getHistoryPage("%1", {
        capture,
        reported: 3,
        before: 0,
        count: 1,
        signal: controller.signal,
      }),
    ).resolves.toEqual({ status: "cancelled" });
    await b.close();
  });

  it("lets output invalidation win when the post-page facts command settles", async () => {
    const controls: FakeControl[] = [];
    const b = new TmuxBackend({
      log,
      hostname: "host",
      execImpl: exec,
      controlFactory: factory(controls),
    });
    await b.connect();
    const capture = (await b.getScreen("%1", { history: true })).historyCapture!;
    const control = controls[0]!;
    const original = control.command.bind(control);
    let historyFactReads = 0;
    control.command = (line) => {
      if (!line.includes("history_limit")) return original(line);
      const response = Promise.resolve(["4\t1\t3\t10\t3\t3\t0"]);
      if (++historyFactReads === 2)
        response.then(() => queueMicrotask(() => control.emit("output", "%1")));
      return response;
    };
    await expect(
      b.getHistoryPage("%1", {
        capture,
        reported: 3,
        before: 3,
        count: 1,
        signal: new AbortController().signal,
      }),
    ).resolves.toEqual({ status: "reset" });
    await expect(
      b.getHistoryPage("%1", {
        capture,
        reported: 3,
        before: 3,
        count: 1,
        signal: new AbortController().signal,
      }),
    ).resolves.toEqual({ status: "reset" });
    await b.close();
  });

  it.each(["cancel", "output", "channel exit"])(
    "stops after deferred initial facts on %s without issuing a range command",
    async (change) => {
      const controls: FakeControl[] = [];
      const b = new TmuxBackend({
        log,
        hostname: "host",
        execImpl: exec,
        controlFactory: factory(controls),
      });
      await b.connect();
      const capture = (await b.getScreen("%1", { history: true })).historyCapture!;
      const control = controls[0]!;
      const original = control.command.bind(control);
      const gate = deferred<string[]>();
      control.command = (line) => (line.includes("history_limit") ? gate.promise : original(line));
      const controller = new AbortController();
      const pending = b.getHistoryPage("%1", {
        capture,
        reported: 3,
        before: 3,
        count: 1,
        signal: controller.signal,
      });
      expect(control.commands.at(-1)).toContain("history_limit");
      if (change === "cancel") controller.abort();
      else if (change === "output") control.emit("output", "%1");
      else control.emit("exit");
      gate.resolve(["4\t1\t3\t10\t3\t3\t0"]);
      await expect(pending).resolves.toEqual(
        change === "cancel" ? { status: "cancelled" } : { status: "reset" },
      );
      expect(control.commands.some((line) => line.includes("-S"))).toBe(false);
      await b.close();
    },
  );

  it.each(["cancel", "output", "channel exit"])(
    "stops after deferred range capture on %s without issuing post facts",
    async (change) => {
      const controls: FakeControl[] = [];
      const b = new TmuxBackend({
        log,
        hostname: "host",
        execImpl: exec,
        controlFactory: factory(controls),
      });
      await b.connect();
      const capture = (await b.getScreen("%1", { history: true })).historyCapture!;
      const control = controls[0]!;
      const original = control.command.bind(control);
      const started = deferred<void>();
      const gate = deferred<string[]>();
      control.command = (line) => {
        if (!line.includes("capture-pane") || !line.includes("-S")) return original(line);
        started.resolve();
        return gate.promise;
      };
      const controller = new AbortController();
      const pending = b.getHistoryPage("%1", {
        capture,
        reported: 3,
        before: 3,
        count: 1,
        signal: controller.signal,
      });
      await started.promise;
      const factsBefore = control.commands.filter((line) => line.includes("history_limit")).length;
      if (change === "cancel") controller.abort();
      else if (change === "output") control.emit("output", "%1");
      else control.emit("exit");
      gate.resolve(["h3"]);
      await expect(pending).resolves.toEqual(
        change === "cancel" ? { status: "cancelled" } : { status: "reset" },
      );
      expect(control.commands.filter((line) => line.includes("history_limit"))).toHaveLength(
        factsBefore,
      );
      await b.close();
    },
  );

  it("gives abort precedence over output invalidation at a deferred final facts command", async () => {
    const controls: FakeControl[] = [];
    const b = new TmuxBackend({
      log,
      hostname: "host",
      execImpl: exec,
      controlFactory: factory(controls),
    });
    await b.connect();
    const capture = (await b.getScreen("%1", { history: true })).historyCapture!;
    const control = controls[0]!;
    const original = control.command.bind(control);
    const started = deferred<void>();
    const gate = deferred<string[]>();
    let facts = 0;
    control.command = (line) => {
      if (!line.includes("history_limit") || ++facts !== 2) return original(line);
      started.resolve();
      return gate.promise;
    };
    const controller = new AbortController();
    const pending = b.getHistoryPage("%1", {
      capture,
      reported: 3,
      before: 3,
      count: 1,
      signal: controller.signal,
    });
    await started.promise;
    controller.abort();
    control.emit("output", "%1");
    gate.resolve(["4\t1\t3\t10\t3\t3\t0"]);
    await expect(pending).resolves.toEqual({ status: "cancelled" });
    await b.close();
  });

  it("resets a suspended range after actual pane removal and same-id recreation", async () => {
    const controls: FakeControl[] = [];
    const b = new TmuxBackend({
      log,
      hostname: "host",
      execImpl: exec,
      controlFactory: factory(controls),
    });
    await b.connect();
    const capture = (await b.getScreen("%1", { history: true })).historyCapture!;
    const control = controls[0]!;
    const original = control.command.bind(control);
    const started = deferred<void>();
    const gate = deferred<string[]>();
    let includePane = true;
    control.command = async (line) => {
      if (line.includes("capture-pane") && line.includes("-S")) {
        started.resolve();
        return gate.promise;
      }
      const rows = await original(line);
      return line.startsWith("list-panes") && !includePane
        ? rows.filter((row) => !row.startsWith("%1\t"))
        : rows;
    };
    const pending = b.getHistoryPage("%1", {
      capture,
      reported: 3,
      before: 3,
      count: 1,
      signal: new AbortController().signal,
    });
    await started.promise;
    includePane = false;
    await (b as unknown as { refreshPanes(): Promise<void> }).refreshPanes();
    includePane = true;
    await (b as unknown as { refreshPanes(): Promise<void> }).refreshPanes();
    const factsBefore = control.commands.filter((line) => line.includes("history_limit")).length;
    gate.resolve(["h3"]);
    await expect(pending).resolves.toEqual({ status: "reset" });
    expect(control.commands.filter((line) => line.includes("history_limit"))).toHaveLength(
      factsBefore,
    );
    await b.close();
  });

  it.each(["cancel", "output", "exit"])(
    "suppresses a stale page after deferred final facts on %s",
    async (change) => {
      const controls: FakeControl[] = [];
      const b = new TmuxBackend({
        log,
        hostname: "host",
        execImpl: exec,
        controlFactory: factory(controls),
      });
      const started = deferred<void>();
      const gate = deferred<string[]>();
      let pending: Promise<unknown> | undefined;
      try {
        await b.connect();
        const capture = (await b.getScreen("%1", { history: true })).historyCapture!;
        const control = controls[0]!;
        const original = control.command.bind(control);
        const intercepted: string[] = [];
        let facts = 0;
        control.command = (line) => {
          intercepted.push(line);
          if (!line.includes("history_limit")) return original(line);
          if (++facts !== 2) return original(line);
          started.resolve();
          return gate.promise;
        };
        const controller = new AbortController();
        pending = b.getHistoryPage("%1", {
          capture,
          reported: 3,
          before: 3,
          count: 1,
          signal: controller.signal,
        });
        await started.promise;
        if (change === "cancel") controller.abort();
        else if (change === "output") control.emit("output", "%1");
        else control.emit("exit");
        const atOwnershipLoss = intercepted.length;
        expect(intercepted.filter((line) => line.includes("history_limit"))).toHaveLength(2);
        gate.resolve(["4\t1\t3\t10\t3\t3\t0"]);
        await expect(pending).resolves.toEqual(
          change === "cancel" ? { status: "cancelled" } : { status: "reset" },
        );
        expect(intercepted).toHaveLength(atOwnershipLoss);
      } finally {
        gate.resolve(["4\t1\t3\t10\t3\t3\t0"]);
        await pending?.catch(() => undefined);
        await b.close();
      }
    },
  );

  it("invalidates a capture before a later page after pane output", async () => {
    const controls: FakeControl[] = [];
    const b = new TmuxBackend({
      log,
      hostname: "host",
      execImpl: exec,
      controlFactory: factory(controls),
    });
    await b.connect();
    const screen = await b.getScreen("%1", { history: true });
    controls[0]?.emit("output", "%1");
    await expect(
      b.getHistoryPage("%1", {
        capture: screen.historyCapture!,
        reported: 3,
        before: 3,
        count: 1,
        signal: new AbortController().signal,
      }),
    ).resolves.toEqual({ status: "reset" });
    expect(controls[0]?.commands.some((line) => line.includes("-S"))).toBe(false);
    await b.close();
  });

  it("reports oldestAvailable > 0 once tmux's history saturates (spec 18.12)", async () => {
    const controls: FakeControl[] = [];
    const b = new TmuxBackend({
      log,
      hostname: "host",
      execImpl: exec,
      controlFactory: factory(controls),
    });
    await b.connect();
    // The pane has scrolled 50 lines but `history-limit` caps the buffer at 3: tmux's own
    // history_size stopped growing while the tracker's monotonic value kept going.
    b.setReported("%1", 50);
    const h = await b.getHistory("%1", 50, 2);
    expect(h.oldestAvailable).toBe(47);
    expect(h.lines.map((l) => l.r[0]?.t)).toEqual(["h2", "h3"]);
    // Asking below the retained window returns nothing rather than a wrong range.
    expect((await b.getHistory("%1", 10, 2)).lines).toEqual([]);
    await b.close();
  });

  it("returns successive exact pages then an end boundary", async () => {
    const b = new TmuxBackend({ log, hostname: "host", execImpl: exec, controlFactory: factory() });
    await b.connect();
    const capture = (await b.getScreen("%1", { history: true })).historyCapture!;
    const signal = new AbortController().signal;
    await expect(
      b.getHistoryPage("%1", { capture, reported: 3, before: 3, count: 2, signal }),
    ).resolves.toMatchObject({ status: "page", from: 1, to: 3 });
    await expect(
      b.getHistoryPage("%1", { capture, reported: 3, before: 1, count: 2, signal }),
    ).resolves.toMatchObject({ status: "page", from: 0, to: 1 });
    await expect(
      b.getHistoryPage("%1", { capture, reported: 3, before: 0, count: 2, signal }),
    ).resolves.toEqual({ status: "boundary", reason: "end", oldestAvailable: 0 });
    await b.close();
  });

  it("returns truncated below a positive oldest boundary and rechecks its final facts", async () => {
    const controls: FakeControl[] = [];
    const b = new TmuxBackend({
      log,
      hostname: "host",
      execImpl: exec,
      controlFactory: factory(controls),
    });
    await b.connect();
    const capture = (await b.getScreen("%1", { history: true })).historyCapture!;
    const signal = new AbortController().signal;
    const baseline = controls[0]!.commands.length;
    await expect(
      b.getHistoryPage("%1", { capture, reported: 50, before: 46, count: 1, signal }),
    ).resolves.toEqual({ status: "boundary", reason: "truncated", oldestAvailable: 47 });
    expect(
      controls[0]!.commands.slice(baseline).filter((line) => line.includes("history_limit")),
    ).toHaveLength(2);
    expect(controls[0]!.commands.some((line) => line.includes("-S"))).toBe(false);

    const control = controls[0]!;
    const original = control.command.bind(control);
    let facts = 0;
    control.command = (line) => {
      if (!line.includes("history_limit")) return original(line);
      const response = Promise.resolve(["4\t1\t3\t10\t3\t3\t0"]);
      if (++facts === 2) response.then(() => queueMicrotask(() => control.emit("output", "%1")));
      return response;
    };
    await expect(
      b.getHistoryPage("%1", {
        capture,
        reported: 50,
        before: 46,
        count: 1,
        signal: new AbortController().signal,
      }),
    ).resolves.toEqual({ status: "reset" });
    await b.close();
  });

  it("does not anchor alternate or post-fact-invalid live screens", async () => {
    const controls: FakeControl[] = [];
    const b = new TmuxBackend({
      log,
      hostname: "host",
      execImpl: exec,
      controlFactory: factory(controls),
    });
    await b.connect();
    controls[0]!.alternate = true;
    expect((await b.getScreen("%1", { history: true })).historyCapture).toBeUndefined();
    controls[0]!.alternate = false;
    const original = controls[0]!.command.bind(controls[0]);
    let facts = 0;
    controls[0]!.command = (line) => {
      if (line.includes("history_limit") && ++facts === 2) return Promise.resolve(["bad"]);
      return original(line);
    };
    expect((await b.getScreen("%1", { history: true })).historyCapture).toBeUndefined();
    await b.close();
  });

  it.each(["initial facts", "visible capture", "post facts"])(
    "omits capture when output arrives during %s acquisition",
    async (phase) => {
      const controls: FakeControl[] = [];
      const b = new TmuxBackend({
        log,
        hostname: "host",
        execImpl: exec,
        controlFactory: factory(controls),
      });
      await b.connect();
      const control = controls[0]!;
      const original = control.command.bind(control);
      let factReads = 0;
      control.command = (line) => {
        const outputDuringFacts =
          line.includes("history_limit") && ++factReads === (phase === "post facts" ? 2 : 1);
        const outputDuringCapture =
          phase === "visible capture" && line.startsWith("capture-pane") && !line.includes("-S");
        if (outputDuringFacts || outputDuringCapture) control.emit("output", "%1");
        return original(line);
      };
      expect((await b.getScreen("%1", { history: true })).historyCapture).toBeUndefined();
      await b.close();
    },
  );

  it("rejects foreign and unknown capture tokens without a range command", async () => {
    const controls: FakeControl[] = [];
    const b = new TmuxBackend({
      log,
      hostname: "host",
      execImpl: exec,
      controlFactory: factory(controls),
    });
    await b.connect();
    const capture = (await b.getScreen("%1", { history: true })).historyCapture!;
    const signal = new AbortController().signal;
    await expect(
      b.getHistoryPage("%2", { capture, reported: 3, before: 3, count: 1, signal }),
    ).resolves.toEqual({ status: "unavailable", reason: "unanchored" });
    await expect(
      b.getHistoryPage("%1", {
        capture: Object.freeze({}),
        reported: 3,
        before: 3,
        count: 1,
        signal,
      }),
    ).resolves.toEqual({ status: "unavailable", reason: "unanchored" });
    expect(controls[0]!.commands.some((line) => line.includes("-S"))).toBe(false);
    await b.close();
  });

  it("returns unavailable rather than fabricating a short or extra range", async () => {
    for (const rows of [["one"], ["one", "two", "three"]]) {
      const controls: FakeControl[] = [];
      const b = new TmuxBackend({
        log,
        hostname: "host",
        execImpl: exec,
        controlFactory: factory(controls),
      });
      await b.connect();
      const capture = (await b.getScreen("%1", { history: true })).historyCapture!;
      const original = controls[0]!.command.bind(controls[0]);
      controls[0]!.command = (line) =>
        line.includes("capture-pane") && line.includes("-S")
          ? Promise.resolve(rows)
          : original(line);
      await expect(
        b.getHistoryPage("%1", {
          capture,
          reported: 3,
          before: 3,
          count: 2,
          signal: new AbortController().signal,
        }),
      ).resolves.toEqual({ status: "unavailable", reason: "changed" });
      await b.close();
    }
  });

  it.each([
    ["higher history size", "4\t1\t4\t10\t3\t3\t0"],
    ["lower history size", "4\t1\t2\t10\t3\t3\t0"],
    ["changed cursor x", "3\t1\t3\t10\t3\t3\t0"],
    ["changed cursor y", "4\t0\t3\t10\t3\t3\t0"],
    ["changed width", "4\t1\t3\t11\t3\t3\t0"],
    ["changed height", "4\t1\t3\t10\t4\t3\t0"],
    ["changed history limit", "4\t1\t3\t10\t3\t4\t0"],
    ["changed alternate", "4\t1\t3\t10\t3\t3\t1"],
  ])("resets and revokes capture on first facts mismatch: %s", async (_name, row) => {
    const controls: FakeControl[] = [];
    const b = new TmuxBackend({
      log,
      hostname: "host",
      execImpl: exec,
      controlFactory: factory(controls),
    });
    try {
      await b.connect();
      const capture = (await b.getScreen("%1", { history: true })).historyCapture!;
      const control = controls[0]!;
      control.history = ["same", "same", "same"];
      const original = control.command.bind(control);
      const intercepted: string[] = [];
      let returnMismatch = true;
      control.command = (line) => {
        intercepted.push(line);
        if (line.includes("history_limit") && returnMismatch) return Promise.resolve([row]);
        return original(line);
      };
      const request = {
        capture,
        reported: 3,
        before: 3,
        count: 1,
        signal: new AbortController().signal,
      };
      await expect(b.getHistoryPage("%1", request)).resolves.toEqual({ status: "reset" });
      expect(intercepted.filter((line) => line.includes("history_limit"))).toHaveLength(1);
      returnMismatch = false;
      const beforeRetry = intercepted.length;
      await expect(b.getHistoryPage("%1", request)).resolves.toEqual({ status: "reset" });
      expect(intercepted).toHaveLength(beforeRetry);
    } finally {
      await b.close();
    }
  });

  it("keeps an unchanged history count valid with repeating rows", async () => {
    const controls: FakeControl[] = [];
    const b = new TmuxBackend({
      log,
      hostname: "host",
      execImpl: exec,
      controlFactory: factory(controls),
    });
    await b.connect();
    const control = controls[0]!;
    control.history = ["same", "same", "same"];
    const capture = (await b.getScreen("%1", { history: true })).historyCapture!;
    await expect(
      b.getHistoryPage("%1", {
        capture,
        reported: 3,
        before: 3,
        count: 2,
        signal: new AbortController().signal,
      }),
    ).resolves.toEqual({
      status: "page",
      from: 1,
      to: 3,
      oldestAvailable: 0,
      lines: [{ r: [{ t: "same" }] }, { r: [{ t: "same" }] }],
    });
    await b.close();
  });

  it.each([
    ["higher history size", "4\t1\t4\t10\t3\t3\t0"],
    ["lower history size", "4\t1\t2\t10\t3\t3\t0"],
    ["cursor x", "3\t1\t3\t10\t3\t3\t0"],
    ["cursor y", "4\t0\t3\t10\t3\t3\t0"],
    ["width", "4\t1\t3\t11\t3\t3\t0"],
    ["height", "4\t1\t3\t10\t4\t3\t0"],
    ["history limit", "4\t1\t3\t10\t3\t4\t0"],
    ["alternate", "4\t1\t3\t10\t3\t3\t1"],
  ])("resets and revokes capture on post-range %s mismatch", async (_name, row) => {
    const controls: FakeControl[] = [];
    const b = new TmuxBackend({
      log,
      hostname: "host",
      execImpl: exec,
      controlFactory: factory(controls),
    });
    try {
      await b.connect();
      const capture = (await b.getScreen("%1", { history: true })).historyCapture!;
      const control = controls[0]!;
      const original = control.command.bind(control);
      const intercepted: string[] = [];
      let facts = 0;
      let returnMismatch = true;
      control.command = (line) => {
        intercepted.push(line);
        if (line.includes("history_limit") && ++facts === 2 && returnMismatch) {
          return Promise.resolve([row]);
        }
        return original(line);
      };
      const request = {
        capture,
        reported: 3,
        before: 3,
        count: 1,
        signal: new AbortController().signal,
      };
      await expect(b.getHistoryPage("%1", request)).resolves.toEqual({ status: "reset" });
      expect(intercepted.filter((line) => line.includes("history_limit"))).toHaveLength(2);
      returnMismatch = false;
      const beforeRetry = intercepted.length;
      await expect(b.getHistoryPage("%1", request)).resolves.toEqual({ status: "reset" });
      expect(intercepted).toHaveLength(beforeRetry);
    } finally {
      await b.close();
    }
  });

  it.each([
    ["malformed first", "malformed", 1],
    ["rejected first", "rejected", 1],
    ["malformed post", "malformed", 2],
    ["rejected post", "rejected", 2],
  ])(
    "returns unavailable but preserves capture after %s facts",
    async (_phase, kind, targetFact) => {
      const controls: FakeControl[] = [];
      const b = new TmuxBackend({
        log,
        hostname: "host",
        execImpl: exec,
        controlFactory: factory(controls),
      });
      await b.connect();
      const capture = (await b.getScreen("%1", { history: true })).historyCapture!;
      const control = controls[0]!;
      const original = control.command.bind(control);
      let facts = 0;
      control.command = (line) => {
        if (!line.includes("history_limit") || ++facts !== targetFact) return original(line);
        return kind === "malformed"
          ? Promise.resolve(["bad facts"])
          : Promise.reject(new Error("facts down"));
      };
      const request = {
        capture,
        reported: 3,
        before: 3,
        count: 1,
        signal: new AbortController().signal,
      };
      await expect(b.getHistoryPage("%1", request)).resolves.toEqual({
        status: "unavailable",
        reason: "changed",
      });
      await expect(b.getHistoryPage("%1", request)).resolves.toMatchObject({ status: "page" });
      await b.close();
    },
  );

  it("returns unavailable but preserves capture after rejected range capture", async () => {
    const controls: FakeControl[] = [];
    const b = new TmuxBackend({
      log,
      hostname: "host",
      execImpl: exec,
      controlFactory: factory(controls),
    });
    await b.connect();
    const capture = (await b.getScreen("%1", { history: true })).historyCapture!;
    const control = controls[0]!;
    const original = control.command.bind(control);
    let once = true;
    control.command = (line) => {
      if (!line.includes("capture-pane") || !line.includes("-S") || !once) return original(line);
      once = false;
      return Promise.reject(new Error("range down"));
    };
    const request = {
      capture,
      reported: 3,
      before: 3,
      count: 1,
      signal: new AbortController().signal,
    };
    await expect(b.getHistoryPage("%1", request)).resolves.toEqual({
      status: "unavailable",
      reason: "changed",
    });
    await expect(b.getHistoryPage("%1", request)).resolves.toMatchObject({ status: "page" });
    await b.close();
  });

  it("keeps a live screen when post-capture facts RPC rejects", async () => {
    const controls: FakeControl[] = [];
    const b = new TmuxBackend({
      log,
      hostname: "host",
      execImpl: exec,
      controlFactory: factory(controls),
    });
    await b.connect();
    const control = controls[0]!;
    const original = control.command.bind(control);
    let facts = 0;
    control.command = (line) => {
      if (!line.includes("history_limit") || ++facts === 1) return original(line);
      return Promise.reject(new Error("post facts down"));
    };
    const screen = await b.getScreen("%1", { history: true });
    expect(screen.lines[0]).toEqual({ r: [{ t: "hello", b: true }] });
    expect(screen.historyCapture).toBeUndefined();
    await b.close();
  });

  it("supports 200-row pages from a saturated 50,000-row capture", async () => {
    const controls: FakeControl[] = [];
    const b = new TmuxBackend({
      log,
      hostname: "host",
      execImpl: exec,
      controlFactory: factory(controls),
    });
    await b.connect();
    const control = controls[0]!;
    control.historySize = 50_000;
    control.historyLimit = 50_000;
    control.history = Array.from({ length: 50_000 }, (_, i) => `h${i}`);
    const capture = (await b.getScreen("%1", { history: true })).historyCapture!;
    const signal = new AbortController().signal;
    const newer = await b.getHistoryPage("%1", {
      capture,
      reported: 50_000,
      before: 50_000,
      count: 200,
      signal,
    });
    const older = await b.getHistoryPage("%1", {
      capture,
      reported: 50_000,
      before: 49_800,
      count: 200,
      signal,
    });
    expect(newer).toMatchObject({ status: "page", from: 49_800, to: 50_000 });
    expect(older).toMatchObject({ status: "page", from: 49_600, to: 49_800 });
    expect(
      control.commands.filter((line) => line.includes("capture-pane") && line.includes("-S")),
    ).toHaveLength(2);
    await b.close();
  });

  it("refuses capture offsets below tmux's signed fetch window", async () => {
    const controls: FakeControl[] = [];
    const b = new TmuxBackend({
      log,
      hostname: "host",
      execImpl: exec,
      controlFactory: factory(controls),
    });
    await b.connect();
    controls[0]!.historySize = 2_147_483_649;
    controls[0]!.historyLimit = 2_147_483_649;
    const capture = (await b.getScreen("%1", { history: true })).historyCapture!;
    await expect(
      b.getHistoryPage("%1", {
        capture,
        reported: 2_147_483_649,
        before: 1,
        count: 2,
        signal: new AbortController().signal,
      }),
    ).resolves.toEqual({ status: "unavailable", reason: "fetch-window" });
    expect(controls[0]!.commands.some((line) => line.includes("-S"))).toBe(false);
    await b.close();
  });

  it("preserves evidence through unchanged refresh then resets it on layout, exit, and reconnect", async () => {
    const controls: FakeControl[] = [];
    const b = new TmuxBackend({
      log,
      hostname: "host",
      execImpl: exec,
      controlFactory: factory(controls),
    });
    await b.connect();
    const capture = (await b.getScreen("%1", { history: true })).historyCapture!;
    await (b as unknown as { refreshPanes(): Promise<void> }).refreshPanes();
    await expect(
      b.getHistoryPage("%1", {
        capture,
        reported: 3,
        before: 3,
        count: 1,
        signal: new AbortController().signal,
      }),
    ).resolves.toMatchObject({ status: "page" });
    controls[0]!.emit("layout");
    await expect(
      b.getHistoryPage("%1", {
        capture,
        reported: 3,
        before: 3,
        count: 1,
        signal: new AbortController().signal,
      }),
    ).resolves.toEqual({ status: "reset" });
    const postLayout = (await b.getScreen("%1", { history: true })).historyCapture!;
    controls[0]!.emit("exit");
    await expect(
      b.getHistoryPage("%1", {
        capture: postLayout,
        reported: 3,
        before: 3,
        count: 1,
        signal: new AbortController().signal,
      }),
    ).resolves.toEqual({ status: "reset" });
    await b.close();
    await b.connect();
    const reconnectCapture = (await b.getScreen("%1", { history: true })).historyCapture!;
    await expect(
      b.getHistoryPage("%1", {
        capture: reconnectCapture,
        reported: 3,
        before: 3,
        count: 1,
        signal: new AbortController().signal,
      }),
    ).resolves.toMatchObject({ status: "page" });
    await b.close();
    await b.connect();
    await expect(
      b.getHistoryPage("%1", {
        capture: reconnectCapture,
        reported: 3,
        before: 3,
        count: 1,
        signal: new AbortController().signal,
      }),
    ).resolves.toEqual({ status: "reset" });
    await b.close();
  });

  it("rejects malformed direct page requests before inspecting evidence", async () => {
    const b = new TmuxBackend({ log, hostname: "host", execImpl: exec, controlFactory: factory() });
    await b.connect();
    await expect(
      b.getHistoryPage("%1", {
        capture: Object.freeze({}),
        reported: -1,
        before: 0,
        count: 1,
        signal: new AbortController().signal,
      }),
    ).rejects.toBeInstanceOf(RangeError);
    await expect(
      b.getHistoryPage("%1", {
        capture: Object.freeze({}),
        reported: 1,
        before: 0,
        count: 201,
        signal: new AbortController().signal,
      }),
    ).rejects.toBeInstanceOf(RangeError);
    await b.close();
  });

  it("resets a capture when a pane is removed then recreated with the same id", async () => {
    const controls: FakeControl[] = [];
    const b = new TmuxBackend({
      log,
      hostname: "host",
      execImpl: exec,
      controlFactory: factory(controls),
    });
    await b.connect();
    const capture = (await b.getScreen("%1", { history: true })).historyCapture!;
    const control = controls[0]!;
    const original = control.command.bind(control);
    let includePane = false;
    control.command = async (line) => {
      const rows = await original(line);
      return line.startsWith("list-panes") && !includePane
        ? rows.filter((row) => !row.startsWith("%1\t"))
        : rows;
    };
    await (b as unknown as { refreshPanes(): Promise<void> }).refreshPanes();
    includePane = true;
    await (b as unknown as { refreshPanes(): Promise<void> }).refreshPanes();
    await expect(
      b.getHistoryPage("%1", {
        capture,
        reported: 3,
        before: 3,
        count: 1,
        signal: new AbortController().signal,
      }),
    ).resolves.toEqual({ status: "reset" });
    await b.close();
  });

  it("a missing command channel is transient, never SessionGone", async () => {
    const controls: FakeControl[] = [];
    const b = new TmuxBackend({
      log,
      hostname: "host",
      execImpl: exec,
      controlFactory: factory(controls),
    });
    await b.connect();
    for (const c of controls) c.alive = false;
    // If this were SessionGone, ScreenTracker would delete the session from every viewer.
    await expect(b.getScreen("%1")).rejects.not.toBeInstanceOf(SessionGone);
    await expect(b.getScreen("%1")).rejects.toThrow(/command channel/);
    // A pane tmux genuinely does not have IS SessionGone.
    await expect(b.getScreen("%404")).rejects.toBeInstanceOf(SessionGone);
    await b.close();
  });

  it("sendText: keys by name, text literally, CR/LF split into Enter", async () => {
    const control = new FakeControl("$0");
    const b = new TmuxBackend({
      log,
      hostname: "host",
      execImpl: exec,
      controlFactory: () => control as unknown as TmuxControl,
    });
    await b.connect();
    const events: string[] = [];
    b.on((e) => {
      events.push(e.type);
    });

    const keys = () => control.commands.filter((c) => c.startsWith("send-keys"));
    await b.sendText("%1", "ls -la\r");
    expect(keys()).toEqual(["send-keys -t %1 -l -- 'ls -la'", "send-keys -t %1 Enter"]);
    await b.sendText("%1", "\x03");
    expect(control.commands.at(-1)).toBe("send-keys -t %1 C-c");
    await b.sendText("%1", "\r");
    expect(control.commands.at(-1)).toBe("send-keys -t %1 Enter");
    await b.sendText("%1", "\t");
    expect(control.commands.at(-1)).toBe("send-keys -t %1 Tab");
    // An embedded newline (a pasted two-line snippet) becomes literal + Enter + literal.
    control.commands.length = 0;
    await b.sendText("%1", "echo a\necho b");
    expect(keys()).toEqual([
      "send-keys -t %1 -l -- 'echo a'",
      "send-keys -t %1 Enter",
      "send-keys -t %1 -l -- 'echo b'",
    ]);
    // A quote in the payload survives tmuxQuote.
    control.commands.length = 0;
    await b.sendText("%1", "echo it's");
    expect(control.commands.at(-1)).toBe("send-keys -t %1 -l -- 'echo it'\\''s'");

    control.emit("output", "%1");
    expect(events).toEqual(["screen-changed"]);
    await b.close();
  });

  it("createSession returns the new pane id and rejects when tmux returns none", async () => {
    const control = new FakeControl("$0");
    const b = new TmuxBackend({
      log,
      hostname: "host",
      execImpl: exec,
      controlFactory: () => control as unknown as TmuxControl,
    });
    await b.connect();
    expect(await b.createSession({ kind: "split", sessionId: "%1", direction: "vertical" })).toBe(
      "%9",
    );
    expect(control.commands.at(-1)).toBe("split-window -P -F '#{pane_id}' -t %1 -h");
    expect(await b.createSession({ kind: "split", sessionId: "%1", direction: "horizontal" })).toBe(
      "%9",
    );
    expect(control.commands.at(-1)).toBe("split-window -P -F '#{pane_id}' -t %1 -v");
    expect(await b.createSession({ kind: "tab", backend: "tmux", windowId: "$0" })).toBe("%9");
    expect(control.commands.at(-1)).toBe("new-window -P -F '#{pane_id}' -t $0");
    expect(await b.createSession({ kind: "tab", backend: "tmux" })).toBe("%9");
    expect(control.commands.at(-1)).toBe("new-session -d -P -F '#{pane_id}'");
    // An empty reply must REJECT, never resolve to "" (the registry would ack `"tmux:"`).
    const empty = new FakeControl("$0");
    empty.command = async () => [];
    const b2 = new TmuxBackend({
      log,
      hostname: "host",
      execImpl: exec,
      controlFactory: () => empty as unknown as TmuxControl,
    });
    await b2.connect();
    await expect(b2.createSession({ kind: "tab", backend: "tmux" })).rejects.toThrow(/no pane id/);
    await b.close();
    await b2.close();
  });

  it("focus is unsupported, and a throwing subscriber cannot break emit()", async () => {
    const control = new FakeControl("$0");
    const b = new TmuxBackend({
      log,
      hostname: "host",
      execImpl: exec,
      controlFactory: () => control as unknown as TmuxControl,
    });
    await b.connect();
    await expect(b.focus("%1")).rejects.toThrow(/unsupported/);
    const seen: string[] = [];
    b.on(() => {
      throw new Error("subscriber blew up");
    });
    b.on((e) => {
      seen.push(e.type);
    });
    expect(() => control.emit("output", "%1")).not.toThrow();
    expect(seen).toEqual(["screen-changed"]);
    await b.close();
  });

  it("refreshPanes emits layout-changed only when the pane SET changes (review fix 1)", async () => {
    let panes = 2;
    class VariablePanesControl extends FakeControl {
      override async command(line: string): Promise<string[]> {
        this.commands.push(line);
        if (line.startsWith("list-panes")) {
          const rows = [
            [
              "%1",
              "$0",
              "main",
              "@0",
              "0",
              "zsh",
              "0",
              "host",
              "/tmp",
              "10",
              "3",
              "1",
              "1",
              "3",
              "0",
              "2",
              "0",
              "zsh",
            ].join("\t"),
            [
              "%2",
              "$0",
              "main",
              "@1",
              "1",
              "build",
              "0",
              "host",
              "/tmp",
              "10",
              "3",
              "1",
              "0",
              "0",
              "0",
              "0",
              "0",
              "make",
            ].join("\t"),
          ];
          return rows.slice(0, panes);
        }
        if (line.startsWith("display-message")) return [`4\t1\t${this.historySize}\t10\t3`];
        if (line.startsWith("capture-pane")) return this.screen;
        throw new Error(`unexpected ${line.split(" ")[0]}`);
      }
    }
    panes = 1;
    const control = new VariablePanesControl("$0");
    const b = new TmuxBackend({
      log,
      hostname: "host",
      execImpl: exec,
      controlFactory: () => control as unknown as TmuxControl,
      refreshDebounceMs: 10,
    });
    await b.connect();
    const events: string[] = [];
    b.on((e) => events.push(e.type));

    // Two consecutive refreshes with an IDENTICAL pane set: nothing to say, nothing emitted.
    control.emit("layout");
    await new Promise((r) => setTimeout(r, 30));
    expect(events).toEqual([]);

    // A new pane appears: session-added for it, then exactly one layout-changed.
    panes = 2;
    control.emit("layout");
    await new Promise((r) => setTimeout(r, 30));
    expect(events).toEqual(["session-added", "layout-changed"]);
    expect((await b.listSessions()).map((s) => s.id)).toEqual(["%1", "%2"]);

    await b.close();
  });

  it("emits exactly one title-changed (and no layout-changed) when a retained pane is renamed (R52)", async () => {
    let windowName = "zsh";
    class RenameableControl extends FakeControl {
      override async command(line: string): Promise<string[]> {
        this.commands.push(line);
        if (line.startsWith("list-panes")) {
          return [
            [
              "%1",
              "$0",
              "main",
              "@0",
              "0",
              windowName,
              "0",
              "host",
              "/tmp",
              "10",
              "3",
              "1",
              "1",
              "3",
              "0",
              "2",
              "0",
              "zsh",
            ].join("\t"),
          ];
        }
        if (line.startsWith("list-clients")) return ["$0\t1", "$0\t0"];
        if (line.startsWith("display-message")) return [`4\t1\t${this.historySize}\t10\t3`];
        if (line.startsWith("capture-pane")) return this.screen;
        throw new Error(`unexpected ${line.split(" ")[0]}`);
      }
    }
    const control = new RenameableControl("$0");
    const b = new TmuxBackend({
      log,
      hostname: "host",
      execImpl: exec,
      controlFactory: () => control as unknown as TmuxControl,
      refreshDebounceMs: 10,
    });
    await b.connect();
    const events: string[] = [];
    b.on((e) => events.push(e.type));

    // The pane SET is unchanged -- only its window name (and therefore displayed title) moves.
    windowName = "renamed";
    control.emit("layout");
    await new Promise((r) => setTimeout(r, 30));
    expect(events).toEqual(["title-changed"]);
    expect(events).not.toContain("layout-changed");
    expect((await b.listSessions())[0]?.title).toBe("renamed");

    await b.close();
  });

  it("createSession validates the target against known ids before touching a command line (review fix 2)", async () => {
    const control = new FakeControl("$0");
    const b = new TmuxBackend({
      log,
      hostname: "host",
      execImpl: exec,
      controlFactory: () => control as unknown as TmuxControl,
    });
    await b.connect();

    // A phone-supplied id that is not a known pane must reject with SessionGone and never reach
    // the command line unvalidated -- an unsanitised interpolation would let `;` inject a second
    // tmux command.
    control.commands.length = 0;
    await expect(
      b.createSession({ kind: "split", sessionId: "%1 ; kill-server", direction: "vertical" }),
    ).rejects.toBeInstanceOf(SessionGone);
    expect(control.commands).toEqual([]);

    // Same for a `windowId` that is not a known tmux session id.
    await expect(
      b.createSession({ kind: "tab", backend: "tmux", windowId: "$99 ; kill-server" }),
    ).rejects.toBeInstanceOf(SessionGone);
    expect(control.commands).toEqual([]);

    // The legitimate paths still work.
    expect(await b.createSession({ kind: "split", sessionId: "%1", direction: "vertical" })).toBe(
      "%9",
    );
    await b.close();
  });

  it("a hung exec() times out; syncBusy releases and the next syncControls still runs (review fix 3)", async () => {
    vi.useFakeTimers();
    try {
      let calls = 0;
      const controls: FakeControl[] = [];
      const hangingExec = (args: string[]): Promise<string> => {
        calls++;
        if (args[0] === "-V") return Promise.resolve("tmux 3.4\n");
        // The THIRD call is `syncControls()`'s own `list-sessions` inside `connect()` (the first
        // two are `detect()`'s `-V` and its own server-check `list-sessions`) -- simulate a
        // wedged tmux server that never answers it.
        if (calls === 3) return new Promise<string>(() => {});
        return Promise.resolve("$0\n");
      };
      const b = new TmuxBackend({
        log,
        hostname: "host",
        execImpl: hangingExec,
        controlFactory: factory(controls),
        watchIntervalMs: 5000,
      });
      const connectPromise = b.connect();
      // Matches the backend's internal `EXEC_TIMEOUT_MS` (not exported); advancing past it lets
      // the hung call's timeout fire.
      await vi.advanceTimersByTimeAsync(5000);
      await connectPromise;
      // The hung call rejected (timed out) rather than wedging connect(); I-1: a FAILED probe is
      // treated as transient, not "no sessions", so it leaves the (here, still-empty, since this
      // is the very first sync) client set untouched rather than actively tearing anything down.
      expect(controls.length).toBe(0);

      // Proof `syncBusy` was released: the NEXT syncControls, via the 5 s watcher, still runs.
      await vi.advanceTimersByTimeAsync(5000);
      expect(controls.length).toBe(1);
      expect(b.isConnected).toBe(true);
      await b.close();
    } finally {
      vi.useRealTimers();
    }
  }, 15_000);

  it("I-1: a transient list-sessions failure on a LATER tick leaves existing clients and panes intact", async () => {
    let fail = false;
    const controls: FakeControl[] = [];
    const flakyExec = async (args: string[]) => {
      if (args[0] === "-V") return "tmux 3.4\n";
      if (args[0] === "list-sessions") {
        if (fail) throw new Error("ETIMEDOUT");
        return "$0\n";
      }
      return "$0\n";
    };
    const b = new TmuxBackend({
      log,
      hostname: "host",
      execImpl: flakyExec,
      controlFactory: factory(controls),
      watchIntervalMs: 20,
    });
    await b.connect();
    expect(controls).toHaveLength(1);
    expect(b.isConnected).toBe(true);
    expect((await b.listSessions()).length).toBeGreaterThan(0);

    // A later watcher tick's list-sessions probe fails transiently (timeout/EAGAIN/a momentarily
    // busy server) -- this must NOT be treated as "no sessions": the already-alive control client
    // and its panes must survive untouched, and `isConnected` must not flip.
    fail = true;
    await new Promise((r) => setTimeout(r, 60));
    expect(controls).toHaveLength(1);
    expect(controls[0]?.alive).toBe(true);
    expect(b.isConnected).toBe(true);
    expect((await b.listSessions()).length).toBeGreaterThan(0);

    await b.close();
  });

  it("a genuinely empty list-sessions (real tmux server with no sessions left) still tears everything down", async () => {
    let empty = false;
    const controls: FakeControl[] = [];
    const varExec = async (args: string[]) => {
      if (args[0] === "-V") return "tmux 3.4\n";
      if (args[0] === "list-sessions") return empty ? "" : "$0\n";
      return "$0\n";
    };
    const b = new TmuxBackend({
      log,
      hostname: "host",
      execImpl: varExec,
      controlFactory: factory(controls),
      watchIntervalMs: 20,
    });
    await b.connect();
    expect(controls).toHaveLength(1);
    const events: string[] = [];
    b.on((e) => events.push(e.type));

    // A genuinely SUCCESSFUL probe that returns no sessions is the real "no sessions" case (spec
    // 8.11's own %exit path arrives the same way in production) -- this one still tears down.
    empty = true;
    await new Promise((r) => setTimeout(r, 60));
    expect(controls.every((c) => !c.alive)).toBe(true);
    expect(await b.listSessions()).toEqual([]);
    expect(events).toContain("session-removed");
    expect(events).toContain("layout-changed");
    expect(b.isConnected).toBe(false);

    await b.close();
  });

  it("M-4: close() landing during connect() must not arm a watcher afterwards", async () => {
    const resolver: { resolve: ((v: string) => void) | null } = { resolve: null };
    const gate = new Promise<string>((r) => {
      resolver.resolve = r;
    });
    let listCalls = 0;
    const controls: FakeControl[] = [];
    const slowExec = async (args: string[]) => {
      if (args[0] === "-V") return "tmux 3.4\n";
      if (args[0] === "list-sessions") {
        listCalls++;
        // The FIRST call is `detect()`'s own server-check; let it resolve immediately so
        // `connect()` reaches `syncControls()`. The SECOND is `syncControls()`'s own probe inside
        // `connect()` -- stall it so `close()` can land while `connect()` is still in flight.
        if (listCalls === 1) return "$0\n";
        return gate;
      }
      return "$0\n";
    };
    const b = new TmuxBackend({
      log,
      hostname: "host",
      execImpl: slowExec,
      controlFactory: factory(controls),
    });
    const connectPromise = b.connect();
    await waitFor(() => listCalls >= 2, 2000);
    await b.close();

    const realSetInterval = global.setInterval;
    let intervalCalls = 0;
    global.setInterval = ((fn: (...a: unknown[]) => void, ms?: number, ...rest: unknown[]) => {
      intervalCalls++;
      return realSetInterval(fn, ms, ...rest);
    }) as typeof setInterval;
    try {
      resolver.resolve?.("$0\n");
      await connectPromise;
    } finally {
      global.setInterval = realSetInterval;
    }
    // The `if (this.closed) return;` guard (M-4) must stop `connect()` from ever reaching the
    // `setInterval(...)` line once a close() has landed during its awaits.
    expect(intervalCalls).toBe(0);
    expect(b.isConnected).toBe(false);
    expect(controls).toHaveLength(0);
  });

  it("getScreen queries display-message before capture-pane (review fix 4)", async () => {
    const control = new FakeControl("$0");
    const b = new TmuxBackend({
      log,
      hostname: "host",
      execImpl: exec,
      controlFactory: () => control as unknown as TmuxControl,
    });
    await b.connect();
    control.commands.length = 0;
    await b.getScreen("%1");
    const order = control.commands.filter(
      (c) => c.startsWith("display-message") || c.startsWith("capture-pane"),
    );
    expect(order[0]?.startsWith("display-message")).toBe(true);
    expect(order[1]?.startsWith("capture-pane")).toBe(true);
    await b.close();
  });

  it("channel() prefers the pane's own tmux session client over an unrelated alive one (review fix 5)", async () => {
    const sessionIds = ["$0", "$1"];
    class TwoSessionControl extends FakeControl {
      override async command(line: string): Promise<string[]> {
        this.commands.push(line);
        if (line.startsWith("list-panes")) {
          return [
            [
              "%1",
              "$0",
              "main",
              "@0",
              "0",
              "zsh",
              "0",
              "host",
              "/tmp",
              "10",
              "3",
              "1",
              "1",
              "3",
              "0",
              "2",
              "0",
              "zsh",
            ].join("\t"),
            [
              "%2",
              "$1",
              "side",
              "@1",
              "0",
              "zsh",
              "0",
              "host",
              "/tmp",
              "10",
              "3",
              "1",
              "1",
              "0",
              "0",
              "0",
              "0",
              "zsh",
            ].join("\t"),
          ];
        }
        if (line.startsWith("display-message")) return [`4\t1\t${this.historySize}\t10\t3`];
        if (line.startsWith("capture-pane")) return this.screen;
        throw new Error(`unexpected ${line.split(" ")[0]}`);
      }
    }
    const controls = new Map<string, TwoSessionControl>();
    const execImpl = async (args: string[]) =>
      args[0] === "-V" ? "tmux 3.4\n" : `${sessionIds.join("\n")}\n`;
    const controlFactory = (sid: string) => {
      const c = new TwoSessionControl(sid);
      controls.set(sid, c);
      return c as unknown as TmuxControl;
    };
    const b = new TmuxBackend({ log, hostname: "host", execImpl, controlFactory });
    await b.connect();

    await b.getScreen("%2");
    expect(controls.get("$1")?.commands.some((c) => c.startsWith("capture-pane"))).toBe(true);
    expect(controls.get("$0")?.commands.some((c) => c.startsWith("capture-pane"))).toBe(false);

    await b.close();
  });

  it("a layout event during an in-flight refresh triggers exactly one follow-up refresh (review fix 6)", async () => {
    let listPanesCalls = 0;
    const release: { fn: (() => void) | null } = { fn: null };
    class GatedControl extends FakeControl {
      override async command(line: string): Promise<string[]> {
        if (line.startsWith("list-panes")) {
          listPanesCalls++;
          if (listPanesCalls === 2) {
            await new Promise<void>((resolve) => {
              release.fn = () => resolve();
            });
          }
        }
        return super.command(line);
      }
    }
    const control = new GatedControl("$0");
    const b = new TmuxBackend({
      log,
      hostname: "host",
      execImpl: exec,
      controlFactory: () => control as unknown as TmuxControl,
      refreshDebounceMs: 100,
    });
    vi.useFakeTimers();
    try {
      const connectPromise = b.connect();
      await vi.advanceTimersByTimeAsync(0);
      await connectPromise;
      expect(listPanesCalls).toBe(1);

      // Trigger a debounced refresh (call #2, gated open).
      control.emit("layout");
      await vi.advanceTimersByTimeAsync(100);
      expect(listPanesCalls).toBe(2);

      // A SECOND layout event arrives while that refresh is still in flight: with the fix, this
      // sets the dirty flag directly instead of arming a separate 100 ms timer.
      control.emit("layout");
      await vi.advanceTimersByTimeAsync(0);

      // Release the gated call: the dirty-loop's own catch-up runs immediately (call #3).
      release.fn?.();
      await vi.advanceTimersByTimeAsync(0);
      expect(listPanesCalls).toBe(3);

      // No separate timer should fire later and cause a 4th call.
      await vi.advanceTimersByTimeAsync(500);
      expect(listPanesCalls).toBe(3);
      await b.close();
    } finally {
      vi.useRealTimers();
    }
  });

  it("connect() is idempotent and does not leak the watcher interval (review fix 7)", async () => {
    vi.useFakeTimers();
    try {
      const b = new TmuxBackend({
        log,
        hostname: "host",
        execImpl: exec,
        controlFactory: factory(),
      });
      await b.connect();
      const afterFirst = vi.getTimerCount();
      await b.connect();
      expect(vi.getTimerCount()).toBe(afterFirst);
      await b.close();
    } finally {
      vi.useRealTimers();
    }
  });

  it("multi-session lifecycle: sessions appear/vanish between watcher ticks; %exit fails over to a surviving client (coverage gap)", async () => {
    vi.useFakeTimers();
    try {
      let sessionIds = ["$0"];
      class DynamicControl extends FakeControl {
        override async command(line: string): Promise<string[]> {
          this.commands.push(line);
          if (line.startsWith("list-panes")) {
            const rows: string[] = [];
            if (sessionIds.includes("$0"))
              rows.push(
                [
                  "%1",
                  "$0",
                  "main",
                  "@0",
                  "0",
                  "zsh",
                  "0",
                  "host",
                  "/tmp",
                  "10",
                  "3",
                  "1",
                  "1",
                  "3",
                  "0",
                  "2",
                  "0",
                  "zsh",
                ].join("\t"),
              );
            if (sessionIds.includes("$1"))
              rows.push(
                [
                  "%2",
                  "$1",
                  "side",
                  "@1",
                  "0",
                  "zsh",
                  "0",
                  "host",
                  "/tmp",
                  "10",
                  "3",
                  "1",
                  "1",
                  "0",
                  "0",
                  "0",
                  "0",
                  "zsh",
                ].join("\t"),
              );
            return rows;
          }
          if (line.startsWith("display-message")) return [`4\t1\t${this.historySize}\t10\t3`];
          if (line.startsWith("capture-pane")) return this.screen;
          throw new Error(`unexpected ${line.split(" ")[0]}`);
        }
      }
      const controls = new Map<string, DynamicControl>();
      const execImpl = async (args: string[]) =>
        args[0] === "-V" ? "tmux 3.4\n" : `${sessionIds.join("\n")}\n`;
      const controlFactory = (sid: string) => {
        const c = new DynamicControl(sid);
        controls.set(sid, c);
        return c as unknown as TmuxControl;
      };
      const b = new TmuxBackend({
        log,
        hostname: "host",
        execImpl,
        controlFactory,
        watchIntervalMs: 5000,
      });
      const events: string[] = [];
      b.on((e) => events.push(e.type));

      await b.connect();
      expect([...controls.keys()]).toEqual(["$0"]);

      // A second tmux session appears between two watcher ticks: its control client starts,
      // and its pane joins the pane map.
      sessionIds = ["$0", "$1"];
      events.length = 0;
      await vi.advanceTimersByTimeAsync(5000);
      expect([...controls.keys()]).toEqual(["$0", "$1"]);
      expect(controls.get("$1")?.alive).toBe(true);
      expect(events).toContain("session-added");
      expect((await b.listSessions()).map((s) => s.id)).toEqual(["%1", "%2"]);

      // "$0"'s control client dies (%exit): "$1"'s client survives and serves as the command
      // channel for a "$0"-owned pane -- review fix 5's fallback keeps the backend working
      // through a single client's outage instead of every command failing.
      const zero = controls.get("$0") as DynamicControl;
      zero.alive = false;
      zero.emit("exit");
      const screen = await b.getScreen("%1");
      expect(screen.rows).toBeGreaterThan(0);

      // The "$1" tmux session itself vanishes (only "$0" remains): its pane is removed and its
      // control client is stopped by the next watcher tick's `syncControls`.
      sessionIds = ["$0"];
      events.length = 0;
      await vi.advanceTimersByTimeAsync(5000);
      expect(controls.get("$1")?.alive).toBe(false);
      expect(events).toContain("session-removed");
      expect((await b.listSessions()).map((s) => s.id)).toEqual(["%1"]);

      await b.close();
    } finally {
      vi.useRealTimers();
    }
  }, 15_000);
});
