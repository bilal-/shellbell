import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { expect, it } from "vitest";
import { TmuxBackend } from "../src/backends/tmux/backend.js";
import { createLogger } from "../src/log.js";
import { disposableTmuxSocket, removeDisposableTmux } from "./fakes/disposable-tmux.js";

const run = promisify(execFile);
const available = await run("tmux", ["-V"]).then(
  () => true,
  () => false,
);

it.skipIf(!available)(
  "keeps the first phone grid without changing later tmux window defaults",
  async () => {
    const socketName = disposableTmuxSocket();
    const tmux = async (...args: string[]) =>
      (await run("tmux", ["-L", socketName, "-f", "/dev/null", ...args])).stdout.trim();
    const backend = new TmuxBackend({
      log: createLogger({ stdout: false }),
      hostname: "fixture",
      socketName,
    });
    try {
      await tmux("new-session", "-d", "-s", "fixture", "/bin/sleep 60");
      await tmux("set-option", "-g", "default-shell", "/bin/sh");
      await tmux("set-option", "-g", "default-command", "/bin/sleep 60");
      await tmux("set-option", "-g", "default-size", "200x50");
      await tmux("set-window-option", "-g", "window-size", "manual");
      const pane = await backend.createFirstSession({ cols: 54, rows: 40 });
      expect(
        await tmux("display-message", "-p", "-t", pane, "#{window_width}x#{window_height}"),
      ).toBe("54x40");
      expect(await tmux("show-options", "-v", "-t", pane, "default-size")).toBe("");
      const { sessionId } = await backend.hostedSessionTarget(pane);
      const next = await tmux("new-window", "-d", "-P", "-F", "#{pane_id}", "-t", sessionId);
      expect(
        await tmux("display-message", "-p", "-t", next, "#{window_width}x#{window_height}"),
      ).toBe("200x50");
      // A user's creation hook owns a different session default; leave it alone.
      await tmux("set-hook", "-g", "after-new-session", "set-option default-size 123x45");
      const hooked = await backend.createFirstSession({ cols: 54, rows: 40 });
      expect(await tmux("show-options", "-v", "-t", hooked, "default-size")).toBe("123x45");
    } finally {
      await backend.close();
      await removeDisposableTmux(socketName);
    }
  },
);
