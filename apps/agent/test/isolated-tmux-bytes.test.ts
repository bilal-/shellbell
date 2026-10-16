import { execFile } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { expect, it, vi } from "vitest";
import { TmuxControl } from "../src/backends/tmux/control.js";
import { createLogger } from "../src/log.js";
import { disposableTmuxSocket, removeDisposableTmux } from "./fakes/disposable-tmux.js";

const run = promisify(execFile);
const available = await run("tmux", ["-V"]).then(
  () => true,
  () => false,
);

it.skipIf(!available)(
  "delivers the exact bytes a disposable tmux pane's program wrote",
  async () => {
    const dir = mkdtempSync(join(tmpdir(), "shellbell-bytes-"));
    const socketName = disposableTmuxSocket();
    const script = join(dir, "fixture.py");
    // Writes 界 and é split across separate writes, raw high bytes, an escape sequence and a
    // backslash, then exits. It also exits after 10 s unprompted, so no shell outlives the test.
    writeFileSync(
      script,
      [
        "import os, select, time, tty",
        // setraw discards pending input, so a key is sent only after READY.
        "tty.setraw(0)",
        "os.write(1, b'READY')",
        "select.select([0], [], [], 10)",
        "for part in [b'\\x1b[31m\\xe7', b'\\x95', b'\\x8c\\x1b[0m\\\\', b'\\xc3', b'\\xa9\\xff\\x00END']:",
        "  os.write(1, part)",
        "  time.sleep(0.02)",
        "time.sleep(10)",
        "",
      ].join("\n"),
      { mode: 0o600 },
    );
    const control = new TmuxControl({
      sessionId: "fixture",
      socketName,
      log: createLogger({ stdout: false }),
    });
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
      const received: Buffer[] = [];
      control.on("bytes", (from, data) => {
        if (from === pane) received.push(Buffer.from(data));
      });
      await control.start();
      await vi.waitFor(() => expect(Buffer.concat(received).toString()).toContain("READY"), {
        timeout: 5000,
      });
      received.length = 0;
      await control.command(`send-keys -t ${pane} -l x`);
      await vi.waitFor(() => expect(Buffer.concat(received).includes("END")).toBe(true), {
        timeout: 5000,
      });
      expect([...Buffer.concat(received)]).toEqual([
        ...Buffer.from("\x1b[31m界\x1b[0m\\é"),
        0xff,
        0x00,
        ...Buffer.from("END"),
      ]);
    } finally {
      control.stop();
      await removeDisposableTmux(socketName);
      rmSync(dir, { recursive: true, force: true });
    }
  },
  20_000,
);
