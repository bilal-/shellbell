import { execFile } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { expect, it } from "vitest";
import { TmuxControl } from "../src/backends/tmux/control.js";
import { createLogger } from "../src/log.js";
import { disposableTmuxSocket, removeDisposableTmux } from "./fakes/disposable-tmux.js";

const run = promisify(execFile);
const available = await run("tmux", ["-V"]).then(
  () => true,
  () => false,
);
const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

it.skipIf(!available)(
  "retires a real failed command group without assigning later replies to it",
  async () => {
    const socketName = disposableTmuxSocket();
    let control: TmuxControl | undefined;
    try {
      const { stdout } = await run("tmux", [
        "-L",
        socketName,
        "-f",
        "/dev/null",
        "new-session",
        "-d",
        "-P",
        "-F",
        "#{session_id}",
      ]);
      control = new TmuxControl({
        sessionId: stdout.trim(),
        socketName,
        log: createLogger({ stdout: false }),
      });
      await control.start();
      const group = expect(
        control.checkpoint([
          "display -p first",
          "capture-pane -p -t %999999999",
          "display -p skipped",
        ]),
      ).rejects.toThrow("tmux error: capture-pane");
      const later = expect(control.command("display -p later")).rejects.toThrow(
        "tmux control exited",
      );
      await Promise.all([group, later]);
      expect(control.alive).toBe(false);
    } finally {
      control?.stop();
      await removeDisposableTmux(socketName);
    }
  },
);

it.skipIf(!available)(
  "cuts one pane's bytes exactly at a capture while other panes flood",
  async () => {
    const dir = mkdtempSync(join(tmpdir(), "shellbell-checkpoint-"));
    const socketName = disposableTmuxSocket();
    // Numbered lines in random-sized writes, so cuts land mid-line; both fixtures exit on their
    // own, so no program outlives the test.
    const counter = join(dir, "counter.py");
    writeFileSync(
      counter,
      [
        "import os, random, time",
        "end = time.time() + 20; i = 0; buf = b''",
        "while time.time() < end:",
        "    while len(buf) < 64:",
        "        i += 1; buf += b'%08d\\n' % i",
        "    n = random.randint(1, 23); os.write(1, buf[:n]); buf = buf[n:]",
        "    if random.random() < 0.3: time.sleep(0.0005)",
      ].join("\n"),
    );
    const flood = join(dir, "flood.py");
    writeFileSync(
      flood,
      [
        "import os, time",
        "end = time.time() + 20; chunk = (b'q' * 79 + b'\\n') * 800",
        "while time.time() < end: os.write(1, chunk)",
      ].join("\n"),
    );
    const tmux = async (...args: string[]) =>
      (await run("tmux", ["-L", socketName, "-f", "/dev/null", ...args])).stdout.trim();
    let control: TmuxControl | undefined;
    try {
      await tmux("new-session", "-d", "-x", "80", "-y", "24", "-s", "s", `python3 ${counter}`);
      await tmux("split-window", "-t", "s", `python3 ${flood}`);
      await tmux("split-window", "-t", "s", `python3 ${flood}`);
      const [pane, ...others] = (
        await tmux("list-panes", "-s", "-t", "s", "-F", "#{pane_id}")
      ).split("\n");
      control = new TmuxControl({
        sessionId: "s",
        socketName,
        log: createLogger({ stdout: false }),
      });
      const received: { pane: string; seq: number; data: Buffer }[] = [];
      control.on("bytes", (from, data, seq) =>
        received.push({ pane: from, seq, data: Buffer.from(data) }),
      );
      await control.start();
      // With every other pane off, nothing can queue ahead of the capture's reply.
      for (const other of others) await control.command(`refresh-client -A '${other}:off'`);

      for (let round = 0; round < 20; round++) {
        await pause(50 + Math.random() * 100);
        const { replies, sentSeq, outputSeq } = await control.checkpoint([
          `capture-pane -p -t ${pane} -S -`,
          `display -p -t ${pane} '#{cursor_y} #{pane_height}'`,
        ]);
        const [rows, [cursor] = []] = replies;
        await pause(100);
        expect(received.some((r) => r.pane !== pane && r.seq > sentSeq && r.seq <= outputSeq)).toBe(
          false,
        );
        const [cursorY, height] = cursor!.split(" ").map(Number);
        const captured = rows!.map((row) => row.trimEnd());
        while (captured.at(-1) === "") captured.pop();
        // A cursor below the last written row means that row ended before the cut.
        const ended = rows!.length - height! + cursorY! > captured.length - 1;
        const after = Buffer.concat(
          received.filter((r) => r.pane === pane && r.seq > outputSeq).map((r) => r.data),
        ).toString("latin1");
        const lines = `${captured.at(-2)}\n${captured.at(-1)}${ended ? "\n" : ""}${after}`
          .split(/\r*\n/)
          .slice(0, -1);
        const numbers = lines.map(Number);
        expect(lines.length).toBeGreaterThan(3);
        expect(lines.every((line) => /^\d{8}$/.test(line))).toBe(true);
        expect(numbers).toEqual(numbers.map((_, i) => numbers[0]! + i));
        received.length = 0;
      }
    } finally {
      control?.stop();
      await removeDisposableTmux(socketName);
      rmSync(dir, { recursive: true, force: true });
    }
  },
  30_000,
);
