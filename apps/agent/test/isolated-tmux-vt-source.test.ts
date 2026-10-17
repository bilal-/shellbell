import { execFile } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { Terminal } from "@xterm/headless";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type TmuxVtEnd, TmuxVtSource } from "../src/backends/tmux/vt-source.js";
import { createLogger } from "../src/log.js";
import { disposableTmuxSocket, removeDisposableTmux } from "./fakes/disposable-tmux.js";

const run = promisify(execFile);
const available = await run("tmux", ["-V"]).then(
  () => true,
  () => false,
);

/** A phone-side xterm fed only what the source emits. */
class Receiver {
  term: Terminal | undefined;
  seeds: { cols: number; rows: number }[] = [];
  ended: TmuxVtEnd | undefined;
  private generation = 0;
  private writes = Promise.resolve();

  constructor(source: TmuxVtSource) {
    source.on("seed", (seed) => {
      this.generation = seed.generation;
      this.seeds.push({ cols: seed.cols, rows: seed.rows });
      this.writes = this.writes.then(() => {
        this.term?.dispose();
        this.term = new Terminal({ cols: seed.cols, rows: seed.rows, allowProposedApi: true });
        return this.write(seed.data);
      });
    });
    source.on("bytes", (data, generation) => {
      expect(generation).toBe(this.generation);
      const copy = new Uint8Array(data);
      this.writes = this.writes.then(() => this.write(copy));
    });
    source.on("end", (reason) => {
      this.ended = reason;
    });
  }

  private write(data: string | Uint8Array): Promise<void> {
    const term = this.term!;
    return new Promise((resolve) => term.write(data, resolve));
  }

  async rows(): Promise<string[]> {
    await this.writes;
    const buffer = this.term!.buffer.active;
    return Array.from({ length: this.term!.rows }, (_, y) =>
      buffer
        .getLine(buffer.baseY + y)!
        .translateToString(true)
        .trimEnd(),
    );
  }
}

/** Polls `check` until it holds; output from tmux arrives on its own schedule. */
async function until(check: () => Promise<boolean>, timeoutMs = 8000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await check())) {
    if (Date.now() > deadline) throw new Error("condition not reached");
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

describe.skipIf(!available)("TmuxVtSource", () => {
  let dir: string;
  let socketName: string;
  let source: TmuxVtSource | undefined;
  const tmux = async (...args: string[]) =>
    (await run("tmux", ["-L", socketName, "-f", "/dev/null", ...args])).stdout.trim();

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "shellbell-vt-source-"));
    socketName = disposableTmuxSocket();
    // Numbered lines in random-sized writes, then DONE; floods write until they exit. Both stop
    // on their own, so no program outlives a test.
    writeFileSync(
      join(dir, "counter.py"),
      [
        "import os, random, sys, time",
        "time.sleep(float(sys.argv[1])); buf = b''.join(b'%06d\\n' % i for i in range(3000))",
        "while buf:",
        "    n = random.randint(1, 40); os.write(1, buf[:n]); buf = buf[n:]",
        "    if random.random() < 0.05: time.sleep(0.001)",
        "os.write(1, b'DONE'); time.sleep(20)",
      ].join("\n"),
    );
    writeFileSync(
      join(dir, "flood.py"),
      [
        "import os, time",
        "end = time.time() + 4; chunk = (b'q' * 70 + b'\\n') * 400",
        "while time.time() < end: os.write(1, chunk)",
        "time.sleep(20)",
      ].join("\n"),
    );
  });

  afterEach(async () => {
    source?.close();
    source = undefined;
    await removeDisposableTmux(socketName);
    rmSync(dir, { recursive: true, force: true });
  });

  async function start(counterDelay: number) {
    const [session, pane] = (
      await tmux(
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
        "#{session_id} #{pane_id}",
        `python3 ${join(dir, "counter.py")} ${counterDelay}`,
      )
    ).split(" ");
    await tmux("split-window", "-t", pane!, `python3 ${join(dir, "flood.py")}`);
    source = new TmuxVtSource({
      tmuxSessionId: session!,
      paneId: pane!,
      socketName,
      log: createLogger({ stdout: false }),
      resizeDebounceMs: 50,
    });
    const receiver = new Receiver(source);
    await source.start();
    return { pane: pane!, receiver };
  }

  const tmuxRows = async (pane: string) =>
    (await tmux("capture-pane", "-p", "-t", pane)).split("\n").map((row) => row.trimEnd());

  async function expectSameScreen(pane: string, receiver: Receiver) {
    await until(async () => (await receiver.rows()).some((row) => row.includes("DONE")));
    const rows = await receiver.rows();
    const expected = await tmuxRows(pane);
    expect(rows.slice(0, expected.length)).toEqual(expected);
  }

  it("continues a seed with the pane's own bytes while another pane floods", async () => {
    const { pane, receiver } = await start(0.3);
    await expectSameScreen(pane, receiver);
    expect(receiver.seeds).toHaveLength(1);
  }, 20_000);

  it("keeps the stream exact when a pane appears mid-stream", async () => {
    const { pane, receiver } = await start(0.6);
    await tmux("split-window", "-t", pane, `python3 ${join(dir, "flood.py")}`);
    await expectSameScreen(pane, receiver);
  }, 20_000);

  it("seeds again at the new size when the pane is resized", async () => {
    const { pane, receiver } = await start(1.5);
    await tmux("resize-window", "-t", pane, "-x", "100", "-y", "30");
    await until(async () => receiver.seeds.length >= 2);
    const width = Number(await tmux("display", "-p", "-t", pane, "#{pane_width}"));
    expect(receiver.seeds.at(-1)!.cols).toBe(width);
    await expectSameScreen(pane, receiver);
  }, 20_000);

  it("ends when its pane closes", async () => {
    const { pane, receiver } = await start(0);
    await tmux("kill-pane", "-t", pane);
    await until(async () => receiver.ended !== undefined);
    expect(receiver.ended).toBe("pane-gone");
  }, 20_000);
});
