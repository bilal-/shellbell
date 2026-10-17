import { execFile } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { type IBuffer, Terminal } from "@xterm/headless";
import { describe, expect, it, vi } from "vitest";
import { TmuxControl } from "../src/backends/tmux/control.js";
import { buildSeed, seedCommands } from "../src/backends/tmux/vt-seed.js";
import { createLogger } from "../src/log.js";
import { disposableTmuxSocket, removeDisposableTmux } from "./fakes/disposable-tmux.js";

const run = promisify(execFile);
const available = await run("tmux", ["-V"]).then(
  () => true,
  () => false,
);

const lines = (n: number, prefix: string) =>
  Array.from({ length: n }, (_, i) => `${prefix}${i}`).join("\r\n");

/**
 * Each scenario is written in two parts. The seed is taken between them, so the second part
 * exercises the state the seed recreated. Second parts set their own colours: tmux does not
 * export the current pen.
 */
const SCENARIOS: Record<string, [string, string]> = {
  "history, wide characters and a wrapped line": [
    `${lines(40, "line ")}\r\n界界 wide\r\n${"w".repeat(130)}\r\n\x1b[1;32mgreen\x1b[0m tail`,
    "\x1b[0m more\r\nnext 界\r\n",
  ],
  "a scroll region with origin mode": [
    `${lines(30, "row ")}\x1b[5;15r\x1b[?6h\x1b[3;4Hinside`,
    `\x1b[0m${"\n".repeat(14)}after\x1b[1;1Htop`,
  ],
  "custom tab stops, insert mode and no autowrap": [
    "\x1b[3g\x1b[1;5H\x1bH\x1b[1;23H\x1bH\x1b[2;1Hab\tcd\tef\x1b[4h\x1b[?7l\x1b[2;1H",
    `\x1b[0mXY\tZ\x1b[3;75H${"m".repeat(12)}`,
  ],
  "the alternate screen over history": [
    `${lines(30, "shell ")}\r\nprompt$ \x1b[?1049h\x1b[H\x1b[2J\x1b[7mtitle\x1b[0m\x1b[10;3Hbody`,
    "\x1b[0m\x1b[12;1Hmore body\x1b[?1049lback at prompt\r\n",
  ],
  "an escape sequence split at the seed": ["before \x1b[3", "1mred\x1b[0m after\r\n"],
  "a hidden block cursor and application cursor keys": [
    "\x1b[?25l\x1b[2 q\x1b[?1h\x1b=text",
    "\x1b[0m more",
  ],
  "full-width coloured rows, as shell prompts draw them": [
    `${lines(30, "out ")}\r\n\x1b[48;5;234m${"p".repeat(80)}\x1b[0m\r\nhello\r\n\x1b[44m${"q".repeat(80)}`,
    "\x1b[0m\r\nafter\r\n",
  ],
};

/** Every row of the active buffer, with each cell's text and colours, then the cursor. */
function snapshot(term: Terminal): string[] {
  const describe = (buffer: IBuffer) => {
    const rows: string[] = [];
    const cell = buffer.getNullCell();
    for (let y = 0; y < buffer.length; y++) {
      const line = buffer.getLine(y)!;
      let row = "";
      for (let x = 0; x < term.cols; x++) {
        line.getCell(x, cell);
        row += `${cell.getChars() || " "}${cell.getFgColorMode()}.${cell.getFgColor()}.${cell.getBgColor()}.${cell.isBold()}.${cell.isInverse()}|`;
      }
      rows.push(row);
    }
    return rows;
  };
  const active = term.buffer.active;
  const rows = describe(active);
  if (active.type === "alternate") rows.push("-- normal --", ...describe(term.buffer.normal));
  return [...rows, `${active.type} ${active.cursorX},${active.cursorY} base ${active.baseY}`];
}

const write = (term: Terminal, data: string | Uint8Array) =>
  new Promise<void>((resolve) => term.write(data, resolve));

describe.skipIf(!available)("tmux pane seed", () => {
  for (const [name, parts] of Object.entries(SCENARIOS)) {
    it(`continues ${name} exactly as an xterm that saw every byte`, async () => {
      const dir = mkdtempSync(join(tmpdir(), "shellbell-seed-"));
      const socketName = disposableTmuxSocket();
      // Writes each part when the test signals its tmux channel; exits on its own after 20 s.
      const fixture = join(dir, "fixture.py");
      writeFileSync(
        fixture,
        [
          "import json, os, subprocess, sys, time, tty",
          "tty.setraw(0)",
          "for i, part in enumerate(json.load(open(sys.argv[2]))):",
          "    subprocess.run(['tmux', '-L', sys.argv[1], 'wait-for', f'part{i}'], timeout=10)",
          "    os.write(1, part.encode('latin1'))",
          "time.sleep(20)",
        ].join("\n"),
      );
      const encoded = parts.map((part) => Buffer.from(part).toString("latin1"));
      writeFileSync(join(dir, "parts.json"), JSON.stringify(encoded));
      const tmux = (...args: string[]) =>
        run("tmux", ["-L", socketName, "-f", "/dev/null", ...args]);
      let control: TmuxControl | undefined;
      try {
        const { stdout } = await tmux(
          "new-session",
          "-d",
          "-x",
          "80",
          "-y",
          "24",
          "-s",
          "s",
          "-P",
          "-F",
          "#{pane_id}",
          `python3 ${fixture} ${socketName} ${join(dir, "parts.json")}`,
        );
        const pane = stdout.trim();
        control = new TmuxControl({
          sessionId: "s",
          socketName,
          log: createLogger({ stdout: false }),
        });
        const received: { seq: number; data: Buffer }[] = [];
        control.on("bytes", (from, data, seq) => {
          if (from === pane) received.push({ seq, data: Buffer.from(data) });
        });
        await control.start();
        const length = () => received.reduce((n, r) => n + r.data.length, 0);

        await tmux("wait-for", "-S", "part0");
        await vi.waitFor(() => expect(length()).toBe(Buffer.byteLength(parts[0])), {
          timeout: 5000,
        });
        const { replies, outputSeq } = await control.checkpoint(seedCommands(pane));
        await tmux("wait-for", "-S", "part1");
        await vi.waitFor(
          () => expect(length()).toBe(Buffer.byteLength(parts[0]) + Buffer.byteLength(parts[1])),
          { timeout: 5000 },
        );

        const seed = buildSeed(replies);
        const options = {
          cols: seed.cols,
          rows: seed.rows,
          scrollback: 1000,
          allowProposedApi: true,
        };
        const reference = new Terminal(options);
        await write(reference, Buffer.concat(received.map((r) => r.data)));
        const seeded = new Terminal(options);
        await write(seeded, seed.data);
        await write(
          seeded,
          Buffer.concat(received.filter((r) => r.seq > outputSeq).map((r) => r.data)),
        );
        expect(snapshot(seeded)).toEqual(snapshot(reference));
        reference.dispose();
        seeded.dispose();
      } finally {
        control?.stop();
        await removeDisposableTmux(socketName);
        rmSync(dir, { recursive: true, force: true });
      }
    }, 20_000);
  }
});
