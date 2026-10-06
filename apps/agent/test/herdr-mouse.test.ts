import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import type { TerminalMouseClick } from "@shellbell/protocol";
import { describe, expect, it, vi } from "vitest";
import { HerdrMouseController } from "../src/backends/herdr/mouse.js";

const click: TerminalMouseClick = {
  column: 12,
  row: 3,
  cols: 80,
  rows: 24,
  button: "left",
  modifiers: 0,
};
function fixture() {
  const stdout = new PassThrough();
  const child = Object.assign(new EventEmitter(), {
    stdin: new PassThrough(),
    stdout,
    stderr: new PassThrough(),
    kill: vi.fn(() => true),
  }) as unknown as ChildProcessWithoutNullStreams;
  let input = "";
  child.stdin.on("data", (data) => {
    input += data.toString();
  });
  child.stdin.on("finish", () => {
    queueMicrotask(() => child.emit("close", 0));
  });
  const spawn = vi.fn(() => child);
  const controller = new HerdrMouseController({
    socketPath: "/fixture/named/herdr.sock",
    executable: "/fixture/herdr",
    env: { HERDR_SESSION: "named" },
    readVersion: async () => "herdr 0.9.3\n",
    spawn,
  });
  return {
    controller,
    child,
    spawn,
    stdout,
    input: () => input,
    frame: (width = 80, height = 24) =>
      stdout.write(`${JSON.stringify({ type: "terminal.frame", width, height })}\n`),
  };
}

describe("Herdr native mouse", () => {
  it("pins the instance and sends one ordered click/release without takeover", async () => {
    const f = fixture();
    await f.controller.configure("0.9.3");
    const pending = f.controller.click("terminal-id", click, () => true);
    expect(f.input()).toBe("");
    f.frame();
    await pending;
    expect(f.spawn).toHaveBeenCalledExactlyOnceWith(
      "/fixture/herdr",
      ["terminal", "session", "control", "terminal-id", "--cols", "80", "--rows", "24"],
      { HERDR_SESSION: "named", HERDR_SOCKET_PATH: "/fixture/named/herdr.sock" },
    );
    expect(
      f
        .input()
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line)),
    ).toEqual([
      { type: "terminal.mouse", action: "down", button: "left", column: 12, row: 3, modifiers: 0 },
      { type: "terminal.mouse", action: "up", button: "left", column: 12, row: 3, modifiers: 0 },
      { type: "terminal.release" },
    ]);
  });

  it.each(["0.8.2", "0.9.2", "0.9.4", "dev", undefined])(
    "does not advertise unmatched native version %s",
    async (version) => {
      const f = fixture();
      await f.controller.configure(version);
      expect(f.controller.available).toBe(false);
      await expect(f.controller.click("terminal-id", click, () => true)).rejects.toThrow(
        "unavailable",
      );
      expect(f.spawn).not.toHaveBeenCalled();
    },
  );

  it.each(["stale", "dimensions", "closed", "overflow"])(
    "rejects %s before writing terminal input",
    async (reason) => {
      const f = fixture();
      await f.controller.configure("0.9.3");
      let current = true;
      const pending = f.controller.click("terminal-id", click, () => current);
      const rejected = expect(pending).rejects.toThrow("unavailable");
      if (reason === "stale") {
        current = false;
        f.frame();
      } else if (reason === "dimensions") f.frame(81);
      else if (reason === "closed") f.child.emit("close", 0);
      else f.stdout.write(Buffer.alloc(1_048_577, 65));
      await rejected;
      expect(f.input()).toBe("");
      expect(f.child.kill).toHaveBeenCalled();
    },
  );

  it("bounds simultaneous control and cancels on backend shutdown", async () => {
    const children: ChildProcessWithoutNullStreams[] = [];
    const controller = new HerdrMouseController({
      socketPath: "/fixture/herdr.sock",
      executable: "/fixture/herdr",
      readVersion: async () => "herdr 0.9.3",
      spawn: () => {
        const f = fixture();
        children.push(f.child);
        return f.child;
      },
    });
    await controller.configure("0.9.3");
    const pending = ["a", "b", "c", "d"].map((target) =>
      controller.click(target, click, () => true).catch((error: Error) => error.message),
    );
    await expect(controller.click("a", click, () => true)).rejects.toThrow("unavailable");
    await expect(controller.click("e", click, () => true)).rejects.toThrow("unavailable");
    expect(children).toHaveLength(4);
    controller.close();
    expect(await Promise.all(pending)).toEqual(
      Array(4).fill("unsupported: mouse control unavailable"),
    );
    expect(children.every((child) => vi.mocked(child.kill).mock.calls.length === 1)).toBe(true);
  });

  it("rejects out-of-grid coordinates without spawning a controller", async () => {
    const f = fixture();
    await f.controller.configure("0.9.3");
    await expect(f.controller.click("a", { ...click, column: 80 }, () => true)).rejects.toThrow(
      "coordinates",
    );
    expect(f.spawn).not.toHaveBeenCalled();
  });

  it("bounds a controller that never produces its first frame", async () => {
    vi.useFakeTimers();
    const f = fixture();
    try {
      await f.controller.configure("0.9.3");
      const pending = f.controller.click("a", click, () => true);
      const rejected = expect(pending).rejects.toThrow("unavailable");
      await vi.advanceTimersByTimeAsync(3000);
      await rejected;
      expect(f.input()).toBe("");
      expect(f.child.kill).toHaveBeenCalledExactlyOnceWith("SIGKILL");
    } finally {
      f.controller.close();
      vi.useRealTimers();
    }
  });

  it("reports uncertain delivery after a failed click without retrying it", async () => {
    const f = fixture();
    await f.controller.configure("0.9.3");
    f.child.stdin.removeAllListeners("finish");
    const pending = f.controller.click("a", click, () => true);
    const rejected = expect(pending).rejects.toThrow("delivery unknown");
    f.frame();
    f.child.emit("close", 1);
    await rejected;
    expect(f.spawn).toHaveBeenCalledTimes(1);
    expect(f.input().split('"action":"down"')).toHaveLength(2);
  });
});
