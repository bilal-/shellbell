import { describe, expect, it, vi } from "vitest";

vi.mock("node:child_process", () => ({
  execFile: (_file: string, _args: string[], _opts: unknown, cb: (err: Error) => void) => {
    // What execFile reports when its timeout kills the child.
    cb(Object.assign(new Error("Command failed"), { killed: true, signal: "SIGKILL", stderr: "" }));
  },
}));

const { ITerm2AuthError, requestCookieAndKey } = await import("../src/backends/iterm2/auth.js");

describe("requestCookieAndKey", () => {
  it("reports an osascript killed at its deadline as a timeout", async () => {
    const err = await requestCookieAndKey("Shellbell", 10).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ITerm2AuthError);
    expect(err).toMatchObject({ kind: "unknown", message: expect.stringMatching(/timed out/) });
  });
});
