import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { TmuxBackend } from "../src/backends/tmux/backend.js";
import { createLogger } from "../src/log.js";

const run = promisify(execFile);
const live = process.env.SHELLBELL_TMUX_E2E === "1";
/** A throwaway server on its own socket — NEVER the operator's default tmux server. */
const SOCK = "shellbell-test";
const tmux = (...args: string[]) => run("tmux", ["-L", SOCK, ...args]);

describe.skipIf(!live)("live tmux", () => {
  let backend: TmuxBackend | null = null;

  beforeAll(async () => {
    // a tiny history-limit makes `history_size` saturate, which is the only way to
    // observe `oldestAvailable > 0` against a real server.
    await tmux("new-session", "-d", "-s", "t", "-x", "60", "-y", "10");
    await tmux("set-option", "-g", "history-limit", "50");
    await tmux("send-keys", "-t", "t", "printf '\\e[31mred\\e[0m plain\\n'", "Enter");
    await new Promise((r) => setTimeout(r, 300));
  }, 20_000);

  afterAll(async () => {
    // Always, even after a failed assertion: the backend's control children and its 5 s watcher
    // must not outlive the suite, or vitest never exits.
    try {
      await backend?.close();
    } finally {
      await tmux("kill-server").catch(() => undefined);
    }
  }, 20_000);

  it("streams %output, captures styled rows, sends keys, reads history", async () => {
    const log = createLogger({ stdout: true, verbose: true });
    const b = new TmuxBackend({ log, socketName: SOCK });
    backend = b;
    await b.connect();
    expect(b.isConnected).toBe(true);

    const changed: string[] = [];
    b.on((e) => {
      if (e.type === "screen-changed") changed.push(e.sessionId);
    });

    const [s] = await b.listSessions();
    if (!s) throw new Error("no pane");

    const screen = await b.getScreen(s.id);
    const text = (ls: typeof screen.lines) =>
      ls.map((l) => l.r.map((r) => r.t).join("")).join("\n");
    expect(text(screen.lines)).toContain("red plain");
    expect(screen.lines.some((l) => l.r.some((r) => r.fg === 1 && r.t.includes("red")))).toBe(true);

    await b.sendText(s.id, "echo shellbell-tmux-ok\r");
    await new Promise((r) => setTimeout(r, 500));
    expect(changed.length).toBeGreaterThan(0);
    const after = await b.getScreen(s.id);
    expect(text(after.lines)).toContain("shellbell-tmux-ok");

    // A quote must survive tmuxQuote against the real tmux parser. Double-quoted (not
    // "echo it's-ok", which is an unbalanced single quote and a genuine shell syntax error --
    // real zsh/bash would drop into a "quote>" continuation prompt instead of ever running it).
    await b.sendText(s.id, 'echo "it\'s-ok"\r');
    await new Promise((r) => setTimeout(r, 500));
    expect(text((await b.getScreen(s.id)).lines)).toContain("it's-ok");
  }, 20_000);

  it("reports oldestAvailable > 0 once history-limit 50 saturates (spec 18.12)", async () => {
    const b = backend as TmuxBackend;
    const [s] = await b.listSessions();
    if (!s) throw new Error("no pane");
    await b.sendText(s.id, "for i in $(seq 1 200); do echo line-$i; done\r");
    await new Promise((r) => setTimeout(r, 2000));
    const screen = await b.getScreen(s.id);
    // tmux's own counter has stopped at the limit while the tracker's would keep climbing.
    expect(screen.scrollbackTotal).toBeLessThanOrEqual(50);
    b.setReported(s.id, 200);
    const h = await b.getHistory(s.id, 200, 10);
    expect(h.oldestAvailable).toBeGreaterThan(0);
    expect(h.lines.length).toBeGreaterThan(0);
  }, 30_000);
});
