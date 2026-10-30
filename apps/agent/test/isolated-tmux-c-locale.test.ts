import { type ChildProcess, execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import { afterEach, expect, it } from "vitest";
import { TmuxBackend } from "../src/backends/tmux/backend.js";
import { createLogger } from "../src/log.js";
import { disposableTmuxSocket, removeDisposableTmux } from "./fakes/disposable-tmux.js";

const run = promisify(execFile);
const available = await run("tmux", ["-V"]).then(
  () => true,
  () => false,
);
const locale = {
  LANG: process.env.LANG,
  LC_ALL: process.env.LC_ALL,
  LC_CTYPE: process.env.LC_CTYPE,
  TMUX: process.env.TMUX,
};
afterEach(() => {
  for (const [key, value] of Object.entries(locale))
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
});

it.skipIf(!available)(
  "sees a window attached to a phone's session when the service has no UTF-8 locale",
  async () => {
    const socketName = disposableTmuxSocket();
    const tmux = async (...args: string[]) =>
      (await run("tmux", ["-u", "-L", socketName, "-f", "/dev/null", ...args])).stdout.trim();
    await tmux("new-session", "-d", "-s", "fixture", "/bin/sleep 60");
    const sessionId = await tmux("display-message", "-p", "-t", "fixture", "#{session_id}");
    // A window's client needs a terminal; `script` gives it one.
    // By name: Linux `script -c` runs a shell, which would expand the `$0` of a session ID.
    const attach = ["tmux", "-u", "-L", socketName, "attach-session", "-t", "fixture"];
    // A desktop window is a capable terminal; a bare CI environment has TERM=dumb or none,
    // which tmux refuses to attach to.
    const spawnOptions = {
      stdio: "ignore",
      env: { ...process.env, TERM: "xterm-256color" },
    } as const;
    const window: ChildProcess =
      process.platform === "darwin"
        ? spawn("script", ["-q", "/dev/null", ...attach], spawnOptions)
        : spawn("script", ["-qfc", attach.join(" "), "/dev/null"], spawnOptions);
    // The Mac app starts the service with no language setting, which tmux treats as plain ASCII.
    process.env.LANG = "C";
    process.env.LC_ALL = "C";
    process.env.LC_CTYPE = "C";
    // tmux also keeps UTF-8 whenever it runs inside tmux.
    delete process.env.TMUX;
    let windowPid = 0;
    const backend = new TmuxBackend({
      log: createLogger({ stdout: false }),
      hostname: "fixture",
      socketName,
      // The client runs under `script`; stand in a desktop app as its parent.
      processTable: async () =>
        new Map([
          [windowPid, { ppid: 99_999_999, args: "tmux attach-session" }],
          [99_999_999, { ppid: 1, args: "/Applications/Ghostty.app/Contents/MacOS/ghostty" }],
        ]),
    });
    try {
      for (let i = 0; i < 40 && !windowPid; i++) {
        const pid = await tmux("list-clients", "-t", sessionId, "-F", "#{client_pid}");
        windowPid = Number(pid.split("\n")[0]) || 0;
        if (!windowPid) await new Promise((resolve) => setTimeout(resolve, 50));
      }
      expect(windowPid).toBeGreaterThan(0);
      expect(await backend.waitForVisibleClient(sessionId, { timeoutMs: 0 })).toBe(true);
    } finally {
      window.kill();
      await backend.close();
      await removeDisposableTmux(socketName);
    }
  },
);
