import { PassThrough } from "node:stream";
import { afterEach, expect, it, vi } from "vitest";
import { bindDesktopOwner } from "../src/native/desktop-owner.js";

const instance = "00000000-0000-4000-8000-000000000001";
const cleanup: (() => void)[] = [];
afterEach(() => {
  for (const close of cleanup.splice(0)) close();
  vi.useRealTimers();
});
function fixture() {
  const input = new PassThrough();
  let stopped = 0;
  const lease = bindDesktopOwner(input, {
    instance,
    onLost: async () => {
      stopped++;
    },
    timeoutMs: 1000,
  });
  cleanup.push(() => {
    lease.close();
    input.destroy();
  });
  return { input, lease, stopped: () => stopped };
}
it("fails closed on EOF before the handshake, exactly once", async () => {
  const f = fixture();
  f.input.end();
  await expect(f.lease.ready).rejects.toThrow();
  await vi.waitFor(() => expect(f.stopped()).toBe(1));
  f.input.destroy();
  expect(f.stopped()).toBe(1);
});
it("accepts a fragmented bounded handshake and stops on owner EOF", async () => {
  const f = fixture(),
    line = `${JSON.stringify({ v: 1, instance })}\n`;
  f.input.write(line.slice(0, 12));
  f.input.write(line.slice(12));
  await f.lease.ready;
  expect(f.stopped()).toBe(0);
  f.input.end();
  await vi.waitFor(() => expect(f.stopped()).toBe(1));
});
it.each([
  "{\n",
  "x".repeat(1025),
  `${JSON.stringify({ v: 1, instance: "wrong" })}\n`,
  `${JSON.stringify({ v: 2, instance })}\n`,
  `${JSON.stringify({ v: 1, instance, extra: true })}\n`,
])("rejects an invalid owner handshake %#", async (message) => {
  const f = fixture();
  f.input.write(message);
  await expect(f.lease.ready).rejects.toThrow();
  await vi.waitFor(() => expect(f.stopped()).toBe(1));
});
it("expires a missing handshake without relying on a fixed sleep", async () => {
  vi.useFakeTimers();
  const f = fixture();
  const result = expect(f.lease.ready).rejects.toThrow();
  await vi.advanceTimersByTimeAsync(1000);
  await result;
  expect(f.stopped()).toBe(1);
});
it("treats extra data after handshake as loss of ownership", async () => {
  const f = fixture();
  f.input.write(`${JSON.stringify({ v: 1, instance })}\n`);
  await f.lease.ready;
  f.input.write("unexpected");
  await vi.waitFor(() => expect(f.stopped()).toBe(1));
});
