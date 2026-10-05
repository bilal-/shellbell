import { PassThrough } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import { runNativeBridge } from "../src/native/bridge.js";
import type { NativeCoordinator } from "../src/native/coordinator.js";
import { NativeControllerError } from "../src/native/protocol.js";

function fixture() {
  const input = new PassThrough();
  const output = new PassThrough();
  const frames: Record<string, unknown>[] = [];
  let bytes = "";
  output.on("data", (chunk) => {
    bytes += chunk.toString();
    let lf = bytes.indexOf("\n");
    while (lf >= 0) {
      frames.push(JSON.parse(bytes.slice(0, lf)));
      bytes = bytes.slice(lf + 1);
      lf = bytes.indexOf("\n");
    }
  });
  let listener: (event: unknown) => void = () => {};
  const coordinator = {
    execute: vi.fn(async () => ({ removed: true })),
    close: vi.fn(),
    onEvent(fn: typeof listener) {
      listener = fn;
      return () => {
        listener = () => {};
      };
    },
  };
  const bridge = runNativeBridge(input, output, coordinator as unknown as NativeCoordinator, {
    agentVersion: "1.0.0",
  });
  return {
    input,
    output,
    frames,
    coordinator,
    bridge,
    event: (value: unknown) => listener(value),
    send(value: unknown) {
      input.write(`${JSON.stringify(value)}\n`);
    },
  };
}
describe("native JSONL bridge", () => {
  it("waits for owned shutdown before completing bridge close", async () => {
    const f = fixture();
    let release!: () => void;
    f.coordinator.close.mockReturnValue(
      new Promise<void>((resolve) => {
        release = resolve;
      }),
    );
    const closed = f.bridge.close();
    await Promise.resolve();
    expect(f.output.writableEnded).toBe(false);
    release();
    await closed;
    expect(f.output.writableEnded).toBe(true);
  });
  it("treats a missing typed mutation result as delivery unknown", async () => {
    const f = fixture();
    f.coordinator.execute.mockResolvedValue({} as never);
    f.send({ v: 1, id: 1, cmd: "hello" });
    f.send({
      v: 1,
      id: 2,
      cmd: "devices.revoke",
      args: { expect: { revision: null, runtime: null }, phoneFp: "b".repeat(26) },
    });
    await vi.waitFor(() => expect(f.frames).toHaveLength(2));
    expect(f.frames[1]).toMatchObject({ ok: false, error: { code: "delivery-unknown" } });
    expect(f.coordinator.execute).toHaveBeenCalledOnce();
    f.bridge.close();
  });
  it("requires hello and accepts fragmented UTF-8 frames", async () => {
    const f = fixture();
    f.input.write('{"v":1,"id":1,"cmd":"hel');
    f.input.write('lo"}\n');
    await vi.waitFor(() => expect(f.frames).toHaveLength(1));
    expect(f.frames[0]).toMatchObject({
      id: 1,
      ok: true,
      data: { version: 1, agentVersion: "1.0.0" },
    });
    f.bridge.close();
    expect(f.coordinator.close).toHaveBeenCalledOnce();
  });
  it("rejects commands before hello without dispatch", async () => {
    const f = fixture();
    f.send({ v: 1, id: 1, cmd: "status" });
    await vi.waitFor(() => expect(f.frames).toHaveLength(1));
    expect(f.frames[0]).toMatchObject({ ok: false, error: { code: "handshake-required" } });
    expect(f.coordinator.execute).not.toHaveBeenCalled();
    f.bridge.close();
  });
  it("does not accept a valid result for the wrong command", async () => {
    const f = fixture();
    f.send({ v: 1, id: 1, cmd: "hello" });
    f.send({ v: 1, id: 2, cmd: "status" });
    await vi.waitFor(() => expect(f.frames).toHaveLength(2));
    expect(f.frames[1]).toMatchObject({ id: 2, ok: false, error: { code: "operation-failed" } });
    f.bridge.close();
  });
  it.each([false, true])(
    "orders early consent after the open result (fragmented=%s)",
    async (fragmented) => {
      const f = fixture(),
        flowId = "f".repeat(22);
      f.coordinator.execute.mockImplementation(async () => {
        f.event({
          v: 1,
          event: "pairing.request",
          flowId,
          challengeId: "c".repeat(22),
          phoneFp: "a".repeat(26),
          name: "Fixture phone",
        });
        return { flowId, qrText: "fixture-qr", expiresAt: 123 } as never;
      });
      f.send({ v: 1, id: 1, cmd: "hello" });
      const frame = Buffer.from(
        `${JSON.stringify({ v: 1, id: 2, cmd: "pairing.open", args: { expect: { revision: null, runtime: null } } })}\n`,
      );
      if (fragmented) for (const byte of frame) f.input.write(Buffer.from([byte]));
      else f.input.write(frame);
      await vi.waitFor(() => expect(f.frames).toHaveLength(3));
      expect(f.frames[1]).toMatchObject({ id: 2, ok: true, data: { flowId } });
      expect(f.frames[2]).toMatchObject({ event: "pairing.request", flowId });
      f.bridge.close();
    },
  );
  it("holds at most one early challenge and closes on wrong flow", async () => {
    const f = fixture();
    f.coordinator.execute.mockImplementation(async () => {
      f.event({
        v: 1,
        event: "pairing.request",
        flowId: "x".repeat(22),
        challengeId: "c".repeat(22),
        phoneFp: "a".repeat(26),
        name: "Fixture",
      });
      return { flowId: "f".repeat(22), qrText: "fixture", expiresAt: 123 } as never;
    });
    f.send({ v: 1, id: 1, cmd: "hello" });
    f.send({
      v: 1,
      id: 2,
      cmd: "pairing.open",
      args: { expect: { revision: null, runtime: null } },
    });
    await vi.waitFor(() => expect(f.coordinator.close).toHaveBeenCalledOnce());
    expect(f.frames.some((x) => x.event)).toBe(false);
  });
  it("reports uncertain revoke once, without retrying or exposing error contents", async () => {
    const f = fixture();
    f.coordinator.execute.mockRejectedValue(new NativeControllerError("delivery-unknown"));
    f.send({ v: 1, id: 1, cmd: "hello" });
    f.send({
      v: 1,
      id: 2,
      cmd: "devices.revoke",
      args: { expect: { revision: null, runtime: null }, phoneFp: "b".repeat(26) },
    });
    await vi.waitFor(() => expect(f.frames).toHaveLength(2));
    expect(f.frames[1]).toEqual({ v: 1, id: 2, ok: false, error: { code: "delivery-unknown" } });
    expect(f.coordinator.execute).toHaveBeenCalledOnce();
    f.bridge.close();
  });
  it("closes on replay IDs, oversized input and partial EOF", () => {
    for (const bytes of [
      '{"v":1,"id":1,"cmd":"hello"}\n{"v":1,"id":1,"cmd":"status"}\n',
      "x".repeat(65537),
      "partial",
    ]) {
      const f = fixture();
      f.input.write(bytes);
      if (bytes === "partial") f.input.emit("end");
      expect(f.coordinator.close).toHaveBeenCalledOnce();
    }
  });
  it.each([
    ["status", 5000, "timeout"],
    ["service.stop", 60000, "delivery-unknown"],
  ] as const)("bounds %s deadline and never retries", async (cmd, deadline, code) => {
    vi.useFakeTimers();
    const f = fixture();
    try {
      f.coordinator.execute.mockImplementation(() => new Promise(() => {}));
      f.send({ v: 1, id: 1, cmd: "hello" });
      f.send({
        v: 1,
        id: 2,
        cmd,
        ...(cmd === "status" ? {} : { args: { expect: { revision: null, runtime: null } } }),
      });
      await vi.advanceTimersByTimeAsync(deadline - 1);
      expect(f.frames).toHaveLength(1);
      await vi.advanceTimersByTimeAsync(1);
      expect(f.frames[1]).toMatchObject({ id: 2, ok: false, error: { code } });
      expect(f.coordinator.execute).toHaveBeenCalledOnce();
    } finally {
      f.bridge.close();
      vi.useRealTimers();
    }
  });
  it("refuses output over its queued byte cap and never dispatches a busy request", async () => {
    const f = fixture();
    f.coordinator.execute.mockImplementation(() => new Promise(() => {}));
    f.send({ v: 1, id: 1, cmd: "hello" });
    f.send({ v: 1, id: 2, cmd: "status" });
    f.send({ v: 1, id: 3, cmd: "devices" });
    expect(f.coordinator.execute).toHaveBeenCalledOnce();
    expect(f.frames[1]).toMatchObject({ id: 3, ok: false, error: { code: "busy" } });
    expect(f.coordinator.close).toHaveBeenCalledOnce();
    const cap = fixture();
    Object.defineProperty(cap.output, "writableLength", { get: () => 262144 });
    cap.send({ v: 1, id: 1, cmd: "hello" });
    expect(cap.frames).toEqual([]);
    expect(cap.coordinator.close).toHaveBeenCalledOnce();
  });
  it("reports unsupported versions with a bounded typed error", () => {
    const f = fixture();
    f.send({ v: 2, id: 1, cmd: "hello" });
    expect(f.frames).toEqual([{ v: 1, id: 1, ok: false, error: { code: "unsupported-version" } }]);
    expect(f.coordinator.execute).not.toHaveBeenCalled();
    f.bridge.close();
  });
});
