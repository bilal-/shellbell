import { execFile } from "node:child_process";
import {
  chmodSync,
  existsSync,
  lutimesSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it, vi } from "vitest";
import { findTerminalExecutable } from "../src/backends/executable.js";
import { findHerdrExecutable } from "../src/backends/herdr/executable.js";
import { BackendRegistry } from "../src/backends/registry.js";
import {
  ghosttyWindowLauncher,
  openOrDiscard,
  terminalAppWindowLauncher,
  terminalCommandLine,
} from "../src/backends/terminal-launch.js";
import { NotShownOnComputer } from "../src/backends/types.js";
import { createLogger } from "../src/log.js";
import { FakeBackend } from "./fakes/fake-backend.js";

describe("terminal window launchers", () => {
  it("skips executable directories when resolving the actual attach program", () => {
    const root = mkdtempSync(join(tmpdir(), "sb-attach-path-"));
    const first = join(root, "a"),
      second = join(root, "b");
    try {
      mkdirSync(join(first, "tmux"), { recursive: true });
      mkdirSync(second);
      writeFileSync(join(second, "tmux"), "#!/bin/sh\nexit 0\n", { mode: 0o700 });
      expect(findTerminalExecutable("tmux", { PATH: `${first}:${second}` })).toBe(
        join(second, "tmux"),
      );
      expect(findTerminalExecutable("tmux", { PATH: relative(process.cwd(), second) })).toBe(
        join(second, "tmux"),
      );
      const local = resolve("herdr");
      expect(findHerdrExecutable({ PATH: ":/unused" }, (path) => path === local)).toBe(local);
      expect(findTerminalExecutable("herdr", { PATH: ":/unused" }, (path) => path === local)).toBe(
        local,
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("finds per-user installs that the service's fixed PATH omits", () => {
    const env = { PATH: "/opt/homebrew/bin:/usr/bin", HOME: "/Users/someone" };
    expect(findHerdrExecutable(env, (path) => path === "/Users/someone/.local/bin/herdr")).toBe(
      "/Users/someone/.local/bin/herdr",
    );
    expect(
      findTerminalExecutable("tmux", env, (path) => path === "/Users/someone/.cargo/bin/tmux"),
    ).toBe("/Users/someone/.cargo/bin/tmux");
    expect(
      findHerdrExecutable(env, (path) =>
        ["/usr/bin/herdr", "/Users/someone/.local/bin/herdr"].includes(path),
      ),
    ).toBe("/usr/bin/herdr");
  });
  it("launches Ghostty when no window or application is open, with fixed native arguments", async () => {
    const execute = vi.fn(async () => {});
    const launcher = ghosttyWindowLauncher({
      platform: "darwin",
      roots: ["/apps"],
      exists: () => true,
      execute,
    })!;
    expect(launcher.available()).toBe(true);
    await launcher.launch({ executable: "/tools/tmux", args: ["attach-session", "-t", "$12"] });
    expect(execute).toHaveBeenCalledWith("/usr/bin/open", [
      "-n",
      "-a",
      "/apps/Ghostty.app",
      "--args",
      "--initial-window=true",
      "--window-save-state=never",
      "--quit-after-last-window-closed=true",
      "--initial-command='/tools/tmux' 'attach-session' '-t' '$12'",
    ]);
    expect(ghosttyWindowLauncher({ platform: "linux" })).toBeNull();
  });
  it("passes paired cell dimensions only to the newly launched Ghostty instance", async () => {
    const execute = vi.fn(async () => {});
    const launcher = ghosttyWindowLauncher({
      platform: "darwin",
      roots: ["/apps"],
      exists: () => true,
      execute,
    })!;
    await launcher.launch({
      executable: "/tools/herdr",
      args: ["terminal", "attach", "new-terminal"],
      initialSize: { cols: 54, rows: 38 },
    });
    expect(execute.mock.calls[0]).toEqual([
      "/usr/bin/open",
      expect.arrayContaining(["-n", "--window-width=54", "--window-height=38"]),
    ]);
    execute.mockClear();
    await expect(
      launcher.launch({ executable: "/tools/herdr", args: [], initialSize: { cols: 1, rows: 1 } }),
    ).rejects.toThrow();
    expect(execute).not.toHaveBeenCalled();
  });

  it("does not launch missing applications and keeps local command words literal", async () => {
    const execute = vi.fn(async () => {});
    const launcher = ghosttyWindowLauncher({ platform: "darwin", exists: () => false, execute })!;
    await expect(launcher.launch({ executable: "/tools/tmux", args: [] })).rejects.toThrow(
      /not installed/,
    );
    expect(execute).not.toHaveBeenCalled();
    expect(
      terminalCommandLine({ executable: "/tools/a'b", args: ["$(touch /tmp/no)", "$12"] }),
    ).toBe("'/tools/a'\\''b' '$(touch /tmp/no)' '$12'");
    expect(() => terminalCommandLine({ executable: "tmux", args: [] })).toThrow();
    expect(() =>
      terminalCommandLine({
        executable: "/tools/tmux",
        args: [],
        environment: { DATA: "a".repeat(8192) },
      }),
    ).toThrow(/large/);
    expect(() => terminalCommandLine({ executable: "/tools/tmux", args: ["bad\nword"] })).toThrow();
    expect(
      terminalCommandLine({
        executable: "/tools/herdr",
        args: ["terminal", "attach", "term_one"],
        environment: { HERDR_SOCKET_PATH: "/private/path with spaces/server.sock" },
      }),
    ).toContain("'HERDR_SOCKET_PATH=/private/path with spaces/server.sock'");
    expect(
      findTerminalExecutable("tmux", { PATH: ".:/bin:/tools" }, (path) => path === "/tools/tmux"),
    ).toBe("/tools/tmux");
  });
  it.each([undefined, { cols: 54, rows: 40 }])(
    "routes a cold hosted request through engine startup with size %j and reuses exactly its first session",
    async (initialSize) => {
      const registry = new BackendRegistry(createLogger({ stdout: false }));
      const backend = new FakeBackend("tmux");
      Object.defineProperty(backend, "isConnected", { value: false, writable: true });
      registry.add(backend);
      const start = vi.fn(async () => {
        Object.defineProperty(backend, "isConnected", { value: true, writable: true });
        return { backend, sessionId: "%1" };
      });
      registry.registerSessionLauncher("tmux", { available: () => true, start });
      const create = vi.fn(async (_backend, firstId) => firstId ?? "%2");
      registry.registerHostedLauncher(
        { backend: "tmux", host: "ghostty", label: "Ghostty" },
        { available: () => true, create },
      );
      expect(registry.launchTargets()).toEqual([
        { backend: "tmux", host: "ghostty", label: "Ghostty" },
      ]);
      expect(
        await registry.createSession({
          kind: "tab",
          backend: "tmux",
          host: "ghostty",
          ...(initialSize ? { initialSize } : {}),
        }),
      ).toBe("tmux:%1");
      expect(start).toHaveBeenCalledOnce();
      expect(start.mock.calls[0]).toEqual(initialSize ? [initialSize] : []);
      expect(create.mock.calls.at(-1)).toEqual(
        initialSize ? [backend, "%1", initialSize] : [backend, "%1"],
      );
      expect(await registry.createSession({ kind: "tab", backend: "tmux", host: "ghostty" })).toBe(
        "tmux:%2",
      );
      expect(start).toHaveBeenCalledOnce();
      await registry.close();
    },
  );
  it("keeps different phone grids owned by their coalesced startup requests", async () => {
    const registry = new BackendRegistry(createLogger({ stdout: false }));
    const backend = new FakeBackend("tmux");
    Object.defineProperty(backend, "isConnected", { value: false, writable: true });
    registry.add(backend);
    let ready!: (result: { backend: typeof backend; sessionId: string }) => void;
    const start = vi.fn(
      () =>
        new Promise<{ backend: typeof backend; sessionId: string }>((resolve) => {
          ready = resolve;
        }),
    );
    const create = vi.fn(async (_backend, firstId) => firstId ?? "%2");
    registry.registerSessionLauncher("tmux", { available: () => true, start });
    registry.registerHostedLauncher(
      { backend: "tmux", host: "ghostty", label: "Ghostty" },
      { available: () => true, create },
    );
    const firstSize = { cols: 54, rows: 40 };
    const secondSize = { cols: 100, rows: 60 };
    const first = registry.createSession({
      kind: "tab",
      backend: "tmux",
      host: "ghostty",
      initialSize: firstSize,
    });
    const second = registry.createSession({
      kind: "tab",
      backend: "tmux",
      host: "ghostty",
      initialSize: secondSize,
    });
    await vi.waitFor(() => expect(start).toHaveBeenCalledExactlyOnceWith(firstSize));
    Object.defineProperty(backend, "isConnected", { value: true, writable: true });
    ready({ backend, sessionId: "%1" });
    expect(await Promise.all([first, second])).toEqual(["tmux:%1", "tmux:%2"]);
    expect(create.mock.calls).toEqual([
      [backend, "%1", firstSize],
      [backend, undefined, secondSize],
    ]);
    await registry.close();
  });

  it("opens a plain phone request in Terminal only when no other window app can", async () => {
    const registry = new BackendRegistry(createLogger({ stdout: false }));
    registry.add(new FakeBackend("tmux"));
    const opened: string[] = [];
    const host = (id: string, label: string) => {
      let available = true;
      const remove = registry.registerHostedLauncher(
        { backend: "tmux", host: id, label },
        {
          available: () => available,
          create: async () => {
            opened.push(id);
            return "%1";
          },
        },
      );
      return {
        remove,
        set available(value: boolean) {
          available = value;
        },
      };
    };
    const terminal = host("terminal", "Terminal");
    const ghostty = host("ghostty", "Ghostty");
    await registry.createSession({ kind: "tab", backend: "tmux" });
    ghostty.available = false;
    await registry.createSession({ kind: "tab", backend: "tmux" });
    expect(opened).toEqual(["ghostty", "terminal"]);
    expect(registry.launchTargets()).toEqual([
      { backend: "tmux", host: "terminal", label: "Terminal" },
    ]);
    terminal.remove();
    await expect(registry.createSession({ kind: "tab", backend: "tmux" })).rejects.toBeInstanceOf(
      NotShownOnComputer,
    );
    await registry.close();
  });

  it("refuses unregistered hosts and existing-window host requests before any creation", async () => {
    const registry = new BackendRegistry(createLogger({ stdout: false }));
    const backend = new FakeBackend("tmux");
    registry.add(backend);
    const nativeCreate = vi.spyOn(backend, "createSession");
    const create = vi.fn(async () => "%1");
    await expect(
      registry.createSession({ kind: "tab", backend: "tmux", host: "remote-command" }),
    ).rejects.toThrow(/unavailable/);
    registry.registerHostedLauncher(
      { backend: "tmux", host: "ghostty", label: "Ghostty" },
      { available: () => true, create },
    );
    await expect(
      registry.createSession({
        kind: "tab",
        backend: "tmux",
        host: "ghostty",
        windowId: "tmux:$0",
      }),
    ).rejects.toThrow(/unavailable/);
    expect(create).not.toHaveBeenCalled();
    expect(nativeCreate).not.toHaveBeenCalled();
    await registry.close();
  });
});

describe("Apple's Terminal as a window for tmux and Herdr", () => {
  const withRoot = async (body: (root: string) => Promise<void>) => {
    const root = mkdtempSync(join(tmpdir(), "sb-terminal-app-"));
    try {
      await body(root);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  };
  const launcherIn = (
    root: string,
    execute: (file: string, args: string[]) => Promise<unknown>,
    extra: { scriptLifetimeMs?: number; now?: () => number } = {},
  ) =>
    terminalAppWindowLauncher({
      platform: "darwin",
      roots: ["/System/Applications/Utilities"],
      exists: (path) => path === "/System/Applications/Utilities/Terminal.app",
      execute,
      scriptRoot: root,
      ...extra,
    })!;

  it("opens a private one-time script in Terminal without asking to control Terminal", async () => {
    await withRoot(async (root) => {
      let script = "";
      let mode = 0;
      let directoryMode = 0;
      const execute = vi.fn(async (_file: string, args: string[]) => {
        const path = args.at(-1)!;
        script = readFileSync(path, "utf8");
        mode = statSync(path).mode & 0o777;
        directoryMode = statSync(dirname(path)).mode & 0o777;
      });
      const launcher = launcherIn(root, execute, { now: () => 1_800_000_000_000 });
      expect(launcher).toMatchObject({ id: "terminal", label: "Terminal" });
      expect(launcher.available()).toBe(true);
      await launcher.launch({
        executable: "/tools/tmux",
        args: ["-L", "default", "attach-session", "-t", "$12"],
        initialSize: { cols: 54, rows: 38 },
      });
      expect(execute).toHaveBeenCalledOnce();
      const [file, args] = execute.mock.calls[0]!;
      // `open -a` with a document: no Apple Events, so macOS never asks to control Terminal.
      expect(file).toBe("/usr/bin/open");
      expect(args.slice(0, 2)).toEqual(["-a", "/System/Applications/Utilities/Terminal.app"]);
      expect(args).toHaveLength(3);
      expect(args[2]).toMatch(/\/shellbell-terminal-[^/]+\/Shellbell\.command$/);
      expect(dirname(dirname(args[2]!))).toBe(root);
      expect(mode).toBe(0o700);
      expect(directoryMode).toBe(0o700);
      expect(script).toBe(
        [
          "#!/bin/sh",
          'rm -f -- "$0"; rmdir -- "$(/usr/bin/dirname -- "$0")" 2>/dev/null',
          '[ "$(/bin/date +%s)" -le 1800000120 ] || exit 0',
          "printf '\\033[8;%s;%st' 38 54",
          "exec '/tools/tmux' '-L' 'default' 'attach-session' '-t' '$12'",
          "",
        ].join("\n"),
      );
    });
  });

  it("leaves no script behind when Terminal cannot be opened", async () => {
    await withRoot(async (root) => {
      const launcher = launcherIn(root, async () => {
        throw new Error("open failed");
      });
      await expect(launcher.launch({ executable: "/tools/tmux", args: [] })).rejects.toThrow(
        /could not be launched/,
      );
      expect(readdirSync(root)).toEqual([]);
    });
  });

  it("removes a script that Terminal never ran", async () => {
    await withRoot(async (root) => {
      const launcher = launcherIn(root, async () => {}, { scriptLifetimeMs: 10 });
      await launcher.launch({ executable: "/tools/tmux", args: [] });
      expect(readdirSync(root)).toHaveLength(1);
      await vi.waitFor(() => expect(readdirSync(root)).toEqual([]));
    });
  });

  it("does nothing when a window opens after its script expired, and still removes it", async () => {
    await withRoot(async (root) => {
      const record = join(root, "record");
      const program = join(root, "program");
      writeFileSync(program, `#!/bin/sh\ntouch '${record}'\n`, { mode: 0o700 });
      let script = "";
      const launcher = launcherIn(
        root,
        async (_file, args) => {
          script = args.at(-1)!;
        },
        { now: () => Date.now() - 10 * 60_000 },
      );
      await launcher.launch({ executable: program, args: [] });
      await promisify(execFile)(script, [], { cwd: root });
      expect(existsSync(record)).toBe(false);
      expect(existsSync(dirname(script))).toBe(false);
    });
  });

  it("removes scripts an earlier process left behind, and nothing else", async () => {
    await withRoot(async (root) => {
      const outside = mkdtempSync(join(tmpdir(), "sb-terminal-outside-"));
      try {
        const old = join(root, "shellbell-terminal-old");
        const fresh = join(root, "shellbell-terminal-fresh");
        // Past its lifetime but recent: a clock jump must not remove a script about to open.
        const recent = join(root, "shellbell-terminal-recent");
        const other = join(root, "other");
        for (const directory of [old, fresh, recent, other]) {
          mkdirSync(directory);
          writeFileSync(join(directory, "Shellbell.command"), "#!/bin/sh\n");
        }
        const long = new Date(Date.now() - 3 * 60 * 60_000);
        utimesSync(old, long, long);
        const minutes = new Date(Date.now() - 10 * 60_000);
        utimesSync(recent, minutes, minutes);
        utimesSync(other, long, long);
        writeFileSync(join(outside, "keep"), "");
        symlinkSync(outside, join(root, "shellbell-terminal-link"));
        lutimesSync(join(root, "shellbell-terminal-link"), long, long);
        await launcherIn(root, async () => {}).launch({ executable: "/tools/tmux", args: [] });
        const left = readdirSync(root);
        expect(left).not.toContain("shellbell-terminal-old");
        expect(left).toEqual(
          expect.arrayContaining([
            "shellbell-terminal-fresh",
            "shellbell-terminal-recent",
            "other",
            "shellbell-terminal-link",
          ]),
        );
        expect(left).toHaveLength(5);
        expect(existsSync(join(outside, "keep"))).toBe(true);
      } finally {
        rmSync(outside, { recursive: true, force: true });
      }
    });
  });

  it("writes nothing into a script folder that is not private", async () => {
    await withRoot(async (root) => {
      const execute = vi.fn(async () => {});
      const shared = join(root, "shared");
      mkdirSync(shared, { mode: 0o755 });
      chmodSync(shared, 0o755);
      const linked = join(root, "linked");
      const target = join(root, "target");
      mkdirSync(target, { mode: 0o700 });
      symlinkSync(target, linked);
      for (const folder of [shared, linked]) {
        await expect(
          launcherIn(folder, execute).launch({ executable: "/tools/tmux", args: [] }),
        ).rejects.toThrow(/could not be prepared/);
      }
      expect(execute).not.toHaveBeenCalled();
      expect(readdirSync(shared)).toEqual([]);
      expect(readdirSync(target)).toEqual([]);
    });
  });

  it("refuses commands that are not literal before writing anything", async () => {
    await withRoot(async (root) => {
      const execute = vi.fn(async () => {});
      const launcher = launcherIn(root, execute);
      for (const command of [
        { executable: "tmux", args: [] },
        { executable: "/tools/tmux", args: ["bad\nword"] },
        { executable: "/tools/tmux", args: [], initialSize: { cols: 1, rows: 1 } },
      ])
        await expect(launcher.launch(command)).rejects.toThrow();
      expect(execute).not.toHaveBeenCalled();
      expect(readdirSync(root)).toEqual([]);
    });
  });

  it("is only offered on a Mac that has Terminal", async () => {
    expect(terminalAppWindowLauncher({ platform: "linux" })).toBeNull();
    const execute = vi.fn(async () => {});
    const missing = terminalAppWindowLauncher({
      platform: "darwin",
      exists: () => false,
      execute,
    })!;
    expect(missing.available()).toBe(false);
    await expect(missing.launch({ executable: "/tools/tmux", args: [] })).rejects.toThrow(
      /missing/,
    );
    expect(execute).not.toHaveBeenCalled();
  });

  it("runs the command with its words unchanged, and the script deletes itself", async () => {
    await withRoot(async (root) => {
      const record = join(root, "record");
      const program = join(root, "program");
      writeFileSync(
        program,
        `#!/bin/sh\nfor word in "$@"; do printf '%s\\n' "$word"; done > '${record}'\nprintf '%s\\n' "$HERDR_SOCKET_PATH" >> '${record}'\n`,
        {
          mode: 0o700,
        },
      );
      let script = "";
      const launcher = launcherIn(join(root), async (_file, args) => {
        script = args.at(-1)!;
      });
      await launcher.launch({
        executable: program,
        args: ["terminal", "attach", "$(touch pwned)", "it's"],
        environment: { HERDR_SOCKET_PATH: "/private/path with spaces/server.sock" },
        initialSize: { cols: 80, rows: 24 },
      });
      // Terminal runs the script the same way: by path, from the person's shell.
      const { stdout } = await promisify(execFile)(script, [], { cwd: root });
      expect(stdout).toBe("\u001b[8;24;80t");
      expect(readFileSync(record, "utf8").split("\n")).toEqual([
        "terminal",
        "attach",
        "$(touch pwned)",
        "it's",
        "/private/path with spaces/server.sock",
        "",
      ]);
      expect(existsSync(script)).toBe(false);
      expect(existsSync(dirname(script))).toBe(false);
      expect(existsSync(join(root, "pwned"))).toBe(false);
    });
  });
});

describe("opening a new session's desktop window", () => {
  it("leaves a session alone once its window opened", async () => {
    const discard = vi.fn(async () => {});
    await openOrDiscard(async () => {}, discard);
    expect(discard).not.toHaveBeenCalled();
  });

  it("closes the new session when its window cannot open, then reports that", async () => {
    const discard = vi.fn(async () => {});
    const failed = openOrDiscard(async () => {
      throw new Error("Ghostty could not be launched");
    }, discard);
    await expect(failed).rejects.toBeInstanceOf(NotShownOnComputer);
    await expect(failed).rejects.toThrow("so the new session was closed");
    expect(discard).toHaveBeenCalledOnce();
  });

  it("says so when the unopened session could not be closed either", async () => {
    await expect(
      openOrDiscard(
        async () => {
          throw new Error("no window");
        },
        async () => {
          throw new Error("no tmux");
        },
      ),
    ).rejects.toThrow("could not be closed");
  });
});
