import { execFile } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, expect, it } from "vitest";
import { paths } from "../src/config.js";

const cli = fileURLToPath(new URL("../src/cli.ts", import.meta.url));
const cwd = fileURLToPath(new URL("..", import.meta.url));
const roots = new Set<string>();
afterEach(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
  roots.clear();
});

/** A running Shellbell's control socket that pairs one phone, then closes its window as `reason`. */
async function fakeShellbell(
  state: string,
  options: { serviceInstance: string | null; reason: "paired" | "closed" | "replaced" },
) {
  const confirms: unknown[] = [];
  const server = createServer((socket: Socket) => {
    let buffer = "";
    socket.on("data", (chunk) => {
      buffer += String(chunk);
      for (let end = buffer.indexOf("\n"); end >= 0; end = buffer.indexOf("\n")) {
        const line = JSON.parse(buffer.slice(0, end)) as { cmd: string; args?: unknown };
        buffer = buffer.slice(end + 1);
        const send = (value: unknown) => socket.write(`${JSON.stringify(value)}\n`);
        if (line.cmd === "status")
          send({ ok: true, data: { process: { serviceInstance: options.serviceInstance } } });
        else if (line.cmd === "pair-open") {
          send({ ok: true, data: { qrText: "fixture", expiresAt: Date.now() + 60_000 } });
          send({ event: "request", phoneFp: "b".repeat(26), name: "Galaxy S22" });
        } else if (line.cmd === "confirm") {
          confirms.push(line.args);
          send({ ok: true, data: null });
          send({ event: "closed", reason: options.reason });
        }
      }
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(paths(state).sock, resolve);
  });
  return { confirms, close: () => new Promise<void>((r) => server.close(() => r())) };
}

function pair(state: string) {
  return new Promise<{ code: number; stdout: string }>((resolve, reject) => {
    execFile(
      process.execPath,
      ["--import", "tsx", cli, "pair", "--yes"],
      { cwd, env: { ...process.env, SHELLBELL_DIR: state }, timeout: 15_000 },
      (error, stdout) => {
        if (error && typeof error.code !== "number") return reject(error);
        resolve({ code: typeof error?.code === "number" ? error.code : 0, stdout });
      },
    );
  });
}

it.each([
  [
    "the background service",
    "550e8400-e29b-41d4-a716-446655440000",
    /Paired with Galaxy S22\. You're all set\./,
  ],
  [
    "a copy in a terminal window",
    null,
    /Paired with Galaxy S22\. Shellbell is running in a terminal window.*shellbell install/,
  ],
])(
  "ends with what happened when %s pairs a phone",
  async (_name, serviceInstance, expected) => {
    const state = mkdtempSync(join(tmpdir(), "sb-pair-"));
    roots.add(state);
    const shellbell = await fakeShellbell(state, { serviceInstance, reason: "paired" });
    try {
      const result = await pair(state);
      expect(result.code).toBe(0);
      expect(result.stdout).toMatch(expected);
      expect(result.stdout).not.toContain("pairing window closed");
      expect(shellbell.confirms).toEqual([{ phoneFp: "b".repeat(26), accept: true }]);
    } finally {
      await shellbell.close();
    }
  },
  20_000,
);

it("says the window closed when no phone paired", async () => {
  const state = mkdtempSync(join(tmpdir(), "sb-pair-"));
  roots.add(state);
  const shellbell = await fakeShellbell(state, { serviceInstance: null, reason: "closed" });
  try {
    const result = await pair(state);
    expect(result.code).toBe(1);
    expect(result.stdout).toContain("pairing window closed");
    expect(result.stdout).not.toContain("Paired with");
  } finally {
    await shellbell.close();
  }
}, 20_000);
