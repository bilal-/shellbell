import { execFile } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { Terminal } from "@xterm/headless";
import { describe, expect, it, vi } from "vitest";
import { lineAnsi } from "../src/backends/herdr/ansi.js";
import { TmuxVtSource } from "../src/backends/tmux/vt-source.js";
import type { VtSeed } from "../src/backends/types.js";
import { createLogger } from "../src/log.js";
import { disposableTmuxSocket, removeDisposableTmux } from "./fakes/disposable-tmux.js";

const run = promisify(execFile);
const available = await run("tmux", ["-V"]).then(
  () => true,
  () => false,
);
const write = (term: Terminal, data: string | Uint8Array) =>
  new Promise<void>((resolve) => term.write(data, resolve));
const rows = (term: Terminal) =>
  Array.from({ length: term.buffer.normal.length }, (_, i) =>
    term.buffer.normal.getLine(i)!.translateToString(true),
  );

describe.skipIf(!available)("raw history from an owned tmux server", () => {
  for (const alternate of [false, true])
    it(`prepends exact physical rows without erasing the seed (alternate=${alternate})`, async () => {
      const dir = mkdtempSync(join(tmpdir(), "shellbell-raw-history-"));
      const socket = disposableTmuxSocket();
      const tmux = async (...args: string[]) =>
        (await run("tmux", ["-L", socket, "-f", "/dev/null", ...args])).stdout.trim();
      let source: TmuxVtSource | undefined;
      let phone: Terminal | undefined;
      let hidden: Terminal | undefined;
      try {
        const content =
          [
            ...Array.from({ length: 60 }, (_, i) => `old${i}`),
            `\x1b[44m${"界".repeat(24)}wide\x1b[0m`,
            "w".repeat(61),
            ...Array.from({ length: 7 }, (_, i) => `tail${i}`),
            "READY",
          ].join("\r\n") + (alternate ? "\x1b[?1049h\x1b[HALT READY" : "");
        writeFileSync(join(dir, "content.bin"), content);
        writeFileSync(
          join(dir, "fixture.py"),
          [
            "import os, subprocess, sys, tty",
            "tty.setraw(0)",
            "def wait(name): subprocess.run(['tmux', '-L', sys.argv[1], 'wait-for', name], check=True)",
            "wait('go')",
            "os.write(1, open(sys.argv[2], 'rb').read())",
            "wait('next')",
            "os.write(1, b'\\r\\nNEXT')",
            "wait('done')",
          ].join("\n"),
        );
        const [session, pane] = (
          await tmux(
            "new-session",
            "-d",
            "-x",
            "20",
            "-y",
            "6",
            "-s",
            "test",
            "-P",
            "-F",
            "#{session_id} #{pane_id}",
            `python3 ${join(dir, "fixture.py")} ${socket} ${join(dir, "content.bin")}`,
          )
        ).split(" ");
        await tmux("set-option", "-g", "status", "off");
        await tmux("wait-for", "-S", "go");
        await vi.waitFor(async () =>
          expect(await tmux("capture-pane", "-p", "-t", pane!)).toContain("READY"),
        );
        source = new TmuxVtSource({
          tmuxSessionId: session!,
          paneId: pane!,
          socketName: socket,
          log: createLogger({ stdout: false }),
        });
        source.history.enable();
        let seed: VtSeed | undefined;
        const output: Uint8Array[] = [];
        source.on("seed", (value) => {
          seed = value;
        });
        source.on("bytes", (value) => {
          output.push(value);
        });
        await source.start(8);
        const native = seed!.nativeHistory;
        expect(native).toBeDefined();
        phone = new Terminal({
          cols: seed!.cols,
          rows: seed!.rows,
          scrollback: 1000,
          allowProposedApi: true,
        });
        hidden = new Terminal({
          cols: seed!.cols,
          rows: seed!.rows,
          scrollback: 1000,
          allowProposedApi: true,
        });
        await write(phone, seed!.data);
        const captured = native!.lines.map((line) =>
          line.r
            .map((run) => run.t)
            .join("")
            .trimEnd(),
        );
        expect(phone.buffer.normal.baseY).toBe(captured.length);
        expect(rows(phone).slice(0, captured.length)).toEqual(captured);
        const request = {
          capture: native!.capture,
          reported: native!.to,
          before: native!.from,
          count: 5,
          signal: new AbortController().signal,
        };
        const page = await source.history.read(request);
        expect(page.status).toBe("page");
        if (page.status !== "page") throw new Error("missing native page");
        await write(hidden, page.lines.map(lineAnsi).join("\r\n") + "\r\n".repeat(seed!.rows));
        await write(hidden, native!.replay);
        expect(rows(hidden)).toEqual([
          ...page.lines.map((line) =>
            line.r
              .map((run) => run.t)
              .join("")
              .trimEnd(),
          ),
          ...rows(phone),
        ]);
        expect(hidden.buffer.active.type).toBe(phone.buffer.active.type);
        await tmux("wait-for", "-S", "next");
        await vi.waitFor(() => expect(Buffer.concat(output).toString()).toContain("NEXT"));
        for (const bytes of output) {
          await write(phone, bytes);
          await write(hidden, bytes);
        }
        expect(rows(hidden).slice(page.lines.length)).toEqual(rows(phone));
        expect(await source.history.read(request)).toMatchObject({ status: "unavailable" });
      } finally {
        source?.close();
        phone?.dispose();
        hidden?.dispose();
        await removeDisposableTmux(socket);
        rmSync(dir, { recursive: true, force: true });
      }
    }, 15_000);
});
