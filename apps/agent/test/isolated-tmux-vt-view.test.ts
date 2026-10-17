import { execFile } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import {
  encodeCbor,
  type StreamChunk,
  type StreamMessage,
  StreamReceiver,
  type StreamTransferMeta,
} from "@shellbell/protocol";
import { Terminal } from "@xterm/headless";
import { expect, it } from "vitest";
import { BackendRegistry } from "../src/backends/registry.js";
import { TmuxBackend } from "../src/backends/tmux/backend.js";
import { createLogger } from "../src/log.js";
import { ServiceViewCoordinator } from "../src/service-view-coordinator.js";
import { disposableTmuxSocket, removeDisposableTmux } from "./fakes/disposable-tmux.js";

const run = promisify(execFile);
const available = await run("tmux", ["-V"]).then(
  () => true,
  () => false,
);

async function until(check: () => Promise<boolean> | boolean, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  while (!(await check())) {
    if (Date.now() > deadline) throw new Error("condition not reached");
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

it.skipIf(!available)(
  "delivers a tmux pane through the service as a seed and bytes an xterm replays exactly",
  async () => {
    const log = createLogger({ stdout: false });
    const dir = mkdtempSync(join(tmpdir(), "shellbell-vt-view-"));
    const socketName = disposableTmuxSocket();
    // Styled, numbered lines in random-sized writes, then DONE; the flood pane competes for the
    // same tmux server. Both exit on their own.
    writeFileSync(
      join(dir, "counter.py"),
      [
        "import os, random, time",
        "time.sleep(0.5)",
        "buf = b''.join(b'\\x1b[3%dm%06d \\xe7\\x95\\x8c\\x1b[0m\\n' % (i % 8, i) for i in range(4000))",
        "while buf:",
        "    n = random.randint(1, 60); os.write(1, buf[:n]); buf = buf[n:]",
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
    const tmux = async (...args: string[]) =>
      (await run("tmux", ["-L", socketName, "-f", "/dev/null", ...args])).stdout.trim();
    const backend = new TmuxBackend({ log, hostname: "fixture", socketName });
    const registry = new BackendRegistry(log);
    let transfer = 0;
    const coordinator = new ServiceViewCoordinator({
      backend: registry,
      log,
      now: () => Date.now(),
      newTransferId: () => `${String(++transfer).padStart(22, "T")}`,
    });
    try {
      const pane = await tmux(
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
        `python3 ${join(dir, "counter.py")}`,
      );
      await tmux("split-window", "-t", pane, `python3 ${join(dir, "flood.py")}`);
      registry.add(backend);
      await backend.connect();
      await until(async () => (await backend.listSessions()).some((s) => s.id === pane));
      coordinator.start();

      const subscriptionId = "S".repeat(22);
      const sessionId = `tmux:${pane}`;
      let term: Terminal | undefined;
      let writes = Promise.resolve();
      let received = 0;
      const metas: StreamTransferMeta["kind"][] = [];
      const lease = coordinator.attach("phone", {
        // A real socket delivers after the send returns; so does this one.
        sendChunk: (chunk: StreamChunk) => {
          queueMicrotask(() => receiver.receive(chunk, encodeCbor(chunk).byteLength));
          return true;
        },
        sendControl: (message: StreamMessage) => {
          throw new Error(`unexpected control ${message.type}`);
        },
      });
      const receiver = new StreamReceiver({
        subscriptionId,
        sessionId,
        now: () => Date.now(),
        accept: (meta, bytes) => {
          metas.push(meta.kind);
          const data = new Uint8Array(bytes);
          if (meta.kind === "vt-state") {
            received = 0;
            writes = writes.then(() => {
              term?.dispose();
              term = new Terminal({ cols: meta.cols, rows: meta.rows, allowProposedApi: true });
              return new Promise((resolve) => term!.write(data, resolve));
            });
          } else if (meta.kind === "vt") {
            expect(meta.offset).toBe(received);
            received += data.length;
            writes = writes.then(() => new Promise((resolve) => term!.write(data, resolve)));
          } else throw new Error(`unexpected ${meta.kind}`);
        },
        acknowledge: (through) => {
          queueMicrotask(() => lease.receive({ type: "stream.ack", subscriptionId, through }, 100));
          return true;
        },
      });
      lease.receive({ type: "stream.subscribe", subscriptionId, sessionId, mode: "vt" }, 100);

      const rows = async () => {
        await writes;
        if (!term) return [];
        const buffer = term.buffer.active;
        return Array.from({ length: term.rows }, (_, y) =>
          buffer
            .getLine(buffer.baseY + y)!
            .translateToString(true)
            .trimEnd(),
        );
      };
      await until(async () => (await rows()).some((row) => row.includes("DONE")));
      const expected = (await tmux("capture-pane", "-p", "-t", pane))
        .split("\n")
        .map((row) => row.trimEnd());
      expect((await rows()).slice(0, expected.length)).toEqual(expected);
      expect(metas[0]).toBe("vt-state");
      expect(metas.filter((kind) => kind === "vt").length).toBeGreaterThan(1);
      lease.close();
    } finally {
      coordinator.stop();
      await backend.close();
      await removeDisposableTmux(socketName);
      rmSync(dir, { recursive: true, force: true });
    }
  },
  30_000,
);
