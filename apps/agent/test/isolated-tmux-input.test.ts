import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { expect, it, vi } from "vitest";
import { TmuxBackend } from "../src/backends/tmux/backend.js";
import { createLogger } from "../src/log.js";

const run = promisify(execFile);
const available = await run("tmux", ["-V"]).then(
  () => true,
  () => false,
);

it.skipIf(!available)(
  "sends exact bytes and live-mode paste into a disposable tmux PTY without leaking private buffers",
  async () => {
    const dir = mkdtempSync(join(tmpdir(), "shellbell-input-"));
    const socketName = `shellbell-test-${randomUUID()}`;
    const capture = join(dir, "received.bin");
    const script = join(dir, "fixture.py");
    const log = createLogger({ stdout: false });
    const backend = new TmuxBackend({ log, hostname: "fixture", socketName });
    writeFileSync(
      script,
      `import os, tty, pathlib\ntty.setraw(0)\nos.write(1,b'\\x1b[?2004hREADY')\ndata=b''\nwhile True:\n data+=os.read(0,4096)\n pathlib.Path(${JSON.stringify(capture)}).write_bytes(data)\n if data.endswith(b'OFF'):\n  os.write(1,b'\\x1b[?2004lMODE-OFF')\n`,
      { mode: 0o600 },
    );
    try {
      const { stdout } = await run("tmux", [
        "-L",
        socketName,
        "-f",
        "/dev/null",
        "new-session",
        "-d",
        "-x",
        "80",
        "-y",
        "24",
        "-s",
        "fixture",
        "-P",
        "-F",
        "#{pane_id}",
        `python3 '${script}'`,
      ]);
      const pane = stdout.trim();
      expect(pane).toMatch(/^%\d+$/);
      await backend.connect();
      await vi.waitFor(async () =>
        expect(
          (await backend.getScreen(pane)).lines
            .flatMap((line) => line.r.map((run) => run.t))
            .join(""),
        ).toContain("READY"),
      );
      const exact = "é\r\n\0\x1b[1;2D'\\;$()";
      await backend.sendInput(pane, exact);
      await vi.waitFor(() =>
        expect(existsSync(capture) && readFileSync(capture).equals(Buffer.from(exact))).toBe(true),
      );
      const pasted = "one\rtwo é'\\;$()";
      const paste = backend.paste(pane, pasted, true);
      const screens = Promise.all(Array.from({ length: 4 }, () => backend.getScreen(pane)));
      await paste;
      for (const screen of await screens)
        expect(screen.lines.flatMap((line) => line.r.map((run) => run.t)).join("")).toContain(
          "READY",
        );
      const bracketed = exact + "\x1b[200~" + pasted + "\x1b[201~\r";
      await vi.waitFor(() =>
        expect(readFileSync(capture).equals(Buffer.from(bracketed))).toBe(true),
      );
      await backend.sendInput(pane, "OFF");
      await vi.waitFor(async () =>
        expect(
          (await backend.getScreen(pane)).lines
            .flatMap((line) => line.r.map((run) => run.t))
            .join(""),
        ).toContain("MODE-OFF"),
      );
      await backend.paste(pane, "plain", false);
      await vi.waitFor(() =>
        expect(readFileSync(capture).equals(Buffer.from(bracketed + "OFFplain"))).toBe(true),
      );
      const buffers = await run("tmux", ["-L", socketName, "list-buffers", "-F", "#{buffer_name}"]);
      expect(buffers.stdout).not.toContain("shellbell-");
      await expect(backend.paste(pane, "invalid\0", true)).rejects.toThrow();
      expect(readFileSync(capture).equals(Buffer.from(bracketed + "OFFplain"))).toBe(true);
    } finally {
      await backend.close();
      await run("tmux", ["-L", socketName, "kill-server"]).catch(() => {});
      rmSync(dir, { recursive: true, force: true });
    }
  },
);
