import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { decodeStreamHistory, prepareStreamHistory } from "@shellbell/protocol";
import { expect, it, vi } from "vitest";
import { TmuxBackend } from "../src/backends/tmux/backend.js";
import type { HistoryReadResult } from "../src/backends/types.js";
import { createLogger } from "../src/log.js";

const run = promisify(execFile);
const available = await run("tmux", ["-V"]).then(
  () => true,
  () => false,
);

it.skipIf(!available)(
  "downloads contiguous styled history from a disposable tmux and refreshes after new output",
  async () => {
    const dir = mkdtempSync(join(tmpdir(), "shellbell-history-"));
    const socketName = `shellbell-test-${randomUUID()}`;
    const script = join(dir, "fixture.py");
    const backend = new TmuxBackend({
      log: createLogger({ stdout: false }),
      hostname: "fixture",
      socketName,
    });
    const text = (index: number) => `H-${String(index).padStart(4, "0")} 界 é 👩‍💻`;
    writeFileSync(
      script,
      `import os, tty\ntty.setraw(0)\nfor i in range(300):\n os.write(1, ('\\x1b[31mH-%04d 界 é 👩‍💻\\x1b[0m\\r\\n' % i).encode('utf-8'))\nos.write(1,b'READY')\nos.read(0,1)\nos.write(1,b'\\r\\nNEW\\r\\nREADY-AGAIN')\nos.read(0,1)\n`,
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
      await backend.connect();
      const plain = (lines: { r: { t: string }[] }[]) =>
        lines.map((line) =>
          line.r
            .map((run) => run.t)
            .join("")
            .trimEnd(),
        );
      await vi.waitFor(async () =>
        expect(plain((await backend.getScreen(pane)).lines)).toContain("READY"),
      );
      const screen = await backend.getScreen(pane, { history: true });
      expect(screen.historyCapture).toBeDefined();
      expect(screen.scrollbackTotal).toBeGreaterThan(200);
      const read = (
        capture = screen.historyCapture!,
        reported = screen.scrollbackTotal,
        before = reported,
      ) =>
        backend.getHistoryPage(pane, {
          capture,
          reported,
          before,
          count: 200,
          signal: new AbortController().signal,
        });
      const page = (value: HistoryReadResult, before: number) => {
        expect(value.status).toBe("page");
        if (value.status !== "page") throw new Error(`History was ${value.status}`);
        const meta = { kind: "history" as const, generation: 1, requestId: "a".repeat(22), before };
        const prepared = prepareStreamHistory({ ...meta, ...value });
        expect(prepared.ok).toBe(true);
        if (!prepared.ok) throw new Error(prepared.code);
        const decoded = decodeStreamHistory(meta, prepared.bytes);
        expect(decoded).toMatchObject({ ...value, nextBefore: value.from });
        expect(plain(value.lines)).toEqual(
          Array.from({ length: value.to - value.from }, (_, index) => text(value.from + index)),
        );
        expect(value.lines.every((line) => line.r.some((run) => run.fg === 1))).toBe(true);
        return value;
      };
      const recent = page(await read(), screen.scrollbackTotal);
      const older = page(
        await read(screen.historyCapture!, screen.scrollbackTotal, recent.from),
        recent.from,
      );
      expect(older.from).toBe(0);
      expect(older.to).toBe(recent.from);
      await expect(read(screen.historyCapture!, screen.scrollbackTotal, 0)).resolves.toEqual({
        status: "boundary",
        reason: "end",
        oldestAvailable: 0,
      });
      await backend.sendInput(pane, "x");
      await vi.waitFor(async () =>
        expect(plain((await backend.getScreen(pane)).lines)).toContain("READY-AGAIN"),
      );
      await expect(read()).resolves.toEqual({ status: "reset" });
      const fresh = await backend.getScreen(pane, { history: true });
      expect(fresh.historyCapture).toBeDefined();
      expect(fresh.scrollbackTotal).toBeGreaterThan(screen.scrollbackTotal);
      page(
        await read(fresh.historyCapture!, fresh.scrollbackTotal, screen.scrollbackTotal),
        screen.scrollbackTotal,
      );
    } finally {
      await backend.close();
      await run("tmux", ["-L", socketName, "kill-server"]).catch(() => {});
      rmSync(dir, { recursive: true, force: true });
    }
  },
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
