import { execFile } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, expect, it } from "vitest";
import { paths } from "../src/config.js";

const cli = fileURLToPath(new URL("../src/cli.ts", import.meta.url));
const cwd = fileURLToPath(new URL("..", import.meta.url));
const roots = new Set<string>();
const commands = [
  ["devices", ["devices"]],
  ["unpair", ["unpair", "fixture"]],
] as const;
function freshState() {
  const state = mkdtempSync(join(tmpdir(), "sb-device-cli-"));
  roots.add(state);
  return state;
}
function run(state: string, args: readonly string[]) {
  return new Promise<{ code: number; stdout: string; stderr: string }>((resolve, reject) => {
    execFile(
      process.execPath,
      ["--import", "tsx", cli, ...args],
      {
        cwd,
        env: { ...process.env, SHELLBELL_DIR: state },
        timeout: 10_000,
      },
      (error, stdout, stderr) => {
        if (error && typeof error.code !== "number") return reject(error);
        resolve({ code: typeof error?.code === "number" ? error.code : 0, stdout, stderr });
      },
    );
  });
}
afterEach(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
  roots.clear();
});

it.each(commands)("%s reports a missing agent as a failed command", async (_name, args) => {
  const result = await run(freshState(), args);
  expect(result.code).toBe(2);
  expect(result.stderr).toMatch(/agent not running/);
  expect(result.stdout).toBe("");
});

it.each(commands)("%s preserves errors from a running control peer", async (_name, args) => {
  const state = freshState();
  const server = createServer((socket) =>
    socket.once("data", () => {
      socket.end(`${JSON.stringify({ ok: false, error: "fixture storage denied" })}\n`);
    }),
  );
  try {
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(paths(state).sock, resolve);
    });
    const result = await run(state, args);
    expect(result.code).toBe(2);
    expect(result.stderr).toContain("fixture storage denied");
    expect(result.stderr).not.toContain("agent not running");
    expect(result.stdout).toBe("");
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

it.each(commands)(
  "%s reports malformed control responses without claiming the agent is absent",
  async (_name, args) => {
    const state = freshState();
    const server = createServer((socket) => socket.once("data", () => socket.end("malformed\n")));
    try {
      await new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(paths(state).sock, resolve);
      });
      const result = await run(state, args);
      expect(result.code).toBe(2);
      expect(result.stderr).toContain("malformed response");
      expect(result.stderr).not.toContain("agent not running");
      expect(result.stdout).toBe("");
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  },
);
