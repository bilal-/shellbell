import { execFile, spawn } from "node:child_process";
import { once } from "node:events";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import type { Line } from "@shellbell/protocol";
import { expect, it, vi } from "vitest";
import { HerdrBackend } from "../src/backends/herdr/backend.js";
import { HerdrClient } from "../src/backends/herdr/client.js";
import type {
  PaneInfoResult,
  PaneReadResult,
  SessionSnapshotResult,
} from "../src/backends/herdr/types.js";
import { createLogger } from "../src/log.js";

const run = promisify(execFile);
const available =
  process.platform !== "win32" &&
  existsSync("/usr/bin/python3") &&
  (await run("herdr", ["--version"]).then(
    () => true,
    () => false,
  ));
const plain = (lines: readonly Line[]) => lines.map((line) => line.r.map((run) => run.t).join(""));
const row = (index: number) => `H-${String(index).padStart(4, "0")} 界 é`;

// Every process, socket, pane, config and persisted session belongs to this fixture.
// This never discovers the user's server and does not require SHELLBELL_LIVE.
async function isolatedHerdr(count: number) {
  const dir = mkdtempSync(join(tmpdir(), "sb-herdr-"));
  const shell = join(dir, "fixture");
  const config = join(dir, "config.toml");
  const socketPath = join(dir, "herdr.sock");
  writeFileSync(
    shell,
    `#!/usr/bin/python3
import os, tty
tty.setraw(0)
for i in range(${count}):
 os.write(1, ('\\x1b[31mH-%04d 界 é\\x1b[0m\\r\\n' % i).encode('utf-8'))
os.write(1,b'READY')
while True:
 command = os.read(0,4096)
 if not command: break
 if b'b' in command: os.write(1,b'\\x1b[2J\\x1b[HPROMPT')
 if b'c' in command: os.write(1,b'\\x1b[2J\\x1b[HPROMPT\\x1b[12;1H')
 if b'd' in command: os.write(1,b'\\x1b[2J\\x1b[HPROMPT\\x1b[24;1H')
`,
    { mode: 0o700 },
  );
  writeFileSync(
    config,
    `onboarding = false
[terminal]
default_shell = ${JSON.stringify(shell)}
[server]
headless_cols = 80
headless_rows = 24
[update]
version_check = false
manifest_check = false
`,
  );
  const env: NodeJS.ProcessEnv = {
    PATH: process.env.PATH,
    LANG: "en_US.UTF-8",
    PYTHONNOUSERSITE: "1",
    TERM: "xterm-256color",
    HERDR_CONFIG_PATH: config,
    HERDR_SOCKET_PATH: socketPath,
    XDG_CONFIG_HOME: join(dir, "config"),
    XDG_STATE_HOME: join(dir, "state"),
    XDG_DATA_HOME: join(dir, "data"),
    XDG_CACHE_HOME: join(dir, "cache"),
  };
  const child = spawn("herdr", ["server"], { cwd: dir, env, stdio: "ignore" });
  let spawnError: Error | undefined;
  child.on("error", (error) => {
    spawnError = error;
  });
  const exited = once(child, "exit").catch(() => {});
  const log = createLogger({ stdout: false });
  const client = new HerdrClient({ log, socketPath });
  const backend = new HerdrBackend({ log, client, syncDebounceMs: 0 });
  const close = async () => {
    await backend.close();
    if (child.exitCode === null && child.signalCode === null && !spawnError) {
      child.kill("SIGTERM");
      try {
        await vi.waitFor(
          () => expect(child.exitCode !== null || child.signalCode !== null).toBe(true),
          { timeout: 5000 },
        );
      } catch {
        child.kill("SIGKILL");
      }
      await exited;
    }
    rmSync(dir, { recursive: true, force: true });
  };
  try {
    await vi.waitFor(
      async () => {
        if (spawnError) throw spawnError;
        await client.ping();
      },
      { timeout: 10_000 },
    );
    await client.request("workspace.create", { cwd: dir, label: "History fixture", focus: true });
    const snapshot = await client.request<SessionSnapshotResult>("session.snapshot", {});
    const pane = snapshot.snapshot.panes[0]!;
    await backend.connect();
    backend.setWatched([pane.terminal_id]);
    await vi.waitFor(
      async () => {
        expect(plain((await backend.getScreen(pane.terminal_id)).lines)).toContain("READY");
      },
      { timeout: 10_000 },
    );
    return { backend, client, pane, close };
  } catch (error) {
    await close();
    throw error;
  }
}

it.skipIf(!available)(
  "pages real Herdr history to its read limit without scrolling the desktop or claiming an end",
  async () => {
    const f = await isolatedHerdr(1500);
    try {
      const info = () => f.client.request<PaneInfoResult>("pane.get", { pane_id: f.pane.pane_id });
      const initial = await info();
      const screen = await f.backend.getScreen(f.pane.terminal_id, { history: true });
      expect(screen.historyCapture).toBeDefined();
      expect(screen.scrollbackTotal).toBeGreaterThan(1000);
      const oldestReadable = screen.scrollbackTotal + screen.rows - 1000;
      let before = screen.scrollbackTotal;
      while (before > oldestReadable) {
        const result = await f.backend.getHistoryPage(f.pane.terminal_id, {
          capture: screen.historyCapture!,
          reported: screen.scrollbackTotal,
          before,
          count: 200,
          signal: new AbortController().signal,
        });
        expect(result).toMatchObject({ status: "page" });
        if (result.status !== "page") throw new Error(`unexpected ${result.status}`);
        expect(result.to).toBe(before);
        expect(result.oldestAvailable).toBe(0);
        expect(plain(result.lines)).toEqual(
          Array.from({ length: result.to - result.from }, (_, i) => row(result.from + i)),
        );
        expect(result.lines.every((line) => line.r.some((run) => run.fg === 1))).toBe(true);
        before = result.from;
      }
      expect(before).toBe(oldestReadable);
      await expect(
        f.backend.getHistoryPage(f.pane.terminal_id, {
          capture: screen.historyCapture!,
          reported: screen.scrollbackTotal,
          before,
          count: 200,
          signal: new AbortController().signal,
        }),
      ).resolves.toEqual({ status: "unavailable", reason: "fetch-window" });
      // Raising the line request cannot bypass Herdr's native cap.
      const recent = await f.client.request<PaneReadResult>("pane.read", {
        pane_id: f.pane.pane_id,
        source: "recent",
        format: "ansi",
        lines: 2000,
      });
      expect(recent.read.text.trimEnd().split("\n")).toHaveLength(1000);
      expect((await info()).pane.scroll).toEqual(initial.pane.scroll);
      await f.backend.sendText(f.pane.terminal_id, "b");
      await vi.waitFor(
        async () => {
          const fresh = await f.backend.getScreen(f.pane.terminal_id, { history: true });
          expect(plain(fresh.lines)[0]).toBe("PROMPT");
          expect(fresh.historyCapture).toBeDefined();
          const result = await f.backend.getHistoryPage(f.pane.terminal_id, {
            capture: fresh.historyCapture!,
            reported: fresh.scrollbackTotal,
            before: oldestReadable,
            count: 200,
            signal: new AbortController().signal,
          });
          expect(result).toMatchObject({ status: "page" });
          if (result.status !== "page") throw new Error(`unexpected ${result.status}`);
          expect(result.from).toBe(fresh.scrollbackTotal + 1 - 1000);
          expect(result.to).toBe(oldestReadable);
          expect(plain(result.lines)).toEqual(
            Array.from({ length: result.to - result.from }, (_, i) => row(result.from + i)),
          );
        },
        { timeout: 5000 },
      );
    } finally {
      await f.close();
    }
  },
  20_000,
);

it.skipIf(!available)(
  "recovers exact styled history with Herdr's native blank viewport trimming",
  async () => {
    const f = await isolatedHerdr(320);
    try {
      for (const command of ["b", "c", "d"]) {
        await f.backend.sendText(f.pane.terminal_id, command);
        await vi.waitFor(async () => {
          expect(plain((await f.backend.getScreen(f.pane.terminal_id)).lines)[0]).toBe("PROMPT");
        });
        const visible = await f.client.request<PaneReadResult>("pane.read", {
          pane_id: f.pane.pane_id,
          source: "visible",
          format: "ansi",
        });
        expect(visible.read.text.trimEnd()).toBe("PROMPT");
        // Retry capture acquisition only while the independent screen observer catches up.
        await vi.waitFor(async () => {
          const screen = await f.backend.getScreen(f.pane.terminal_id, { history: true });
          expect(screen.historyCapture).toBeDefined();
          const result = await f.backend.getHistoryPage(f.pane.terminal_id, {
            capture: screen.historyCapture!,
            reported: screen.scrollbackTotal,
            before: screen.scrollbackTotal,
            count: 200,
            signal: new AbortController().signal,
          });
          expect(result).toMatchObject({ status: "page" });
          if (result.status !== "page") throw new Error(`unexpected ${result.status}`);
          expect(plain(result.lines)).toEqual(
            Array.from({ length: 200 }, (_, i) => row(result.from + i)),
          );
          expect(result.lines.every((line) => line.r.some((run) => run.fg === 1))).toBe(true);
        });
      }
    } finally {
      await f.close();
    }
  },
  20_000,
);
