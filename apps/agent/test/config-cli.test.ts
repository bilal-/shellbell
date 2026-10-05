import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { loadConfig, paths } from "../src/config.js";

const cliPath = fileURLToPath(new URL("../src/cli.ts", import.meta.url));
const roots = new Set<string>();

function freshState() {
  const root = mkdtempSync(join(tmpdir(), "sb-config-cli-"));
  roots.add(root);
  return { root, stateDir: join(root, "state") };
}

function runCli(stateDir: string, args: string[]) {
  return spawnSync(process.execPath, ["--import", "tsx", cliPath, ...args], {
    cwd: fileURLToPath(new URL("..", import.meta.url)),
    env: { ...process.env, SHELLBELL_DIR: stateDir },
    encoding: "utf8",
    timeout: 10_000,
  });
}

afterEach(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
  roots.clear();
});

describe("config CLI", () => {
  it.each([
    ["unknown key", ["config", "set", "unknown", "x"]],
    ["unknown operation", ["config", "nope", "name", "x"]],
    ["bad threshold", ["config", "set", "idleQuietMs", "0"]],
    ["invalid relay", ["config", "set", "relay", "http://relay.example"]],
    ["invalid name", ["config", "set", "name", "x".repeat(65)]],
    ["invalid accent", ["config", "set", "accent", "beige"]],
  ])("rejects %s without creating state", (_name, args) => {
    const { stateDir } = freshState();
    const result = runCli(stateDir, args);

    expect(result.error).toBeUndefined();
    expect(result.status).not.toBe(0);
    expect(existsSync(stateDir)).toBe(false);
    expect(existsSync(paths(stateDir).config)).toBe(false);
  });

  it("keeps Commander missing-argument failures nonzero and side-effect free", () => {
    const { stateDir } = freshState();
    const result = runCli(stateDir, ["config", "set", "name"]);

    expect(result.error).toBeUndefined();
    expect(result.status).not.toBe(0);
    expect(result.stderr).toMatch(/missing required argument/i);
    expect(existsSync(stateDir)).toBe(false);
  });

  it.each([
    ["unknown key", ["config", "set", "unknown", "x"]],
    ["unknown operation", ["config", "nope", "name", "x"]],
    ["bad threshold", ["config", "set", "idleQuietMs", "0"]],
    ["invalid relay", ["config", "set", "relay", "http://relay.example"]],
    ["invalid name", ["config", "set", "name", "x".repeat(65)]],
    ["invalid accent", ["config", "set", "accent", "beige"]],
    ["missing argument", ["config", "set", "name"]],
  ])("leaves an existing config byte-for-byte unchanged for %s", (_name, args) => {
    const { stateDir } = freshState();
    const p = paths(stateDir);
    loadConfig(p);
    const before = readFileSync(p.config);

    const result = runCli(stateDir, args);

    expect(result.status).not.toBe(0);
    expect(readFileSync(p.config)).toEqual(before);
  });

  it("saves valid name and threshold values with restrictive permissions and restart guidance", () => {
    const { stateDir } = freshState();
    const nameResult = runCli(stateDir, ["config", "set", "name", "Studio Mac"]);

    expect(nameResult.status).toBe(0);
    expect(nameResult.stdout).toMatch(/saved/i);
    expect(nameResult.stdout).toMatch(/running agent must be restarted/i);
    const p = paths(stateDir);
    expect(JSON.parse(readFileSync(p.config, "utf8")).computerName).toBe("Studio Mac");
    expect(statSync(p.dir).mode & 0o777).toBe(0o700);
    expect(statSync(p.config).mode & 0o777).toBe(0o600);

    const thresholdResult = runCli(stateDir, ["--json", "config", "set", "idleQuietMs", "30000"]);
    expect(thresholdResult.status).toBe(0);
    expect(JSON.parse(thresholdResult.stdout)).toEqual({ saved: true, restartRequired: true });
    expect(thresholdResult.stdout).not.toMatch(/saved\s+\{/i);
    expect(JSON.parse(readFileSync(p.config, "utf8")).idleQuietMs).toBe(30_000);
  });

  it("prints structured JSON for action errors", () => {
    const { stateDir } = freshState();
    const result = runCli(stateDir, ["--json", "config", "set", "unknown", "x"]);

    expect(result.status).toBe(2);
    expect(JSON.parse(result.stdout)).toMatchObject({
      error: expect.stringMatching(/unknown key/),
    });
    expect(result.stderr).toBe("");
    expect(existsSync(stateDir)).toBe(false);
  });

  it("does not overwrite or disclose malformed config contents", () => {
    const { stateDir } = freshState();
    const p = paths(stateDir);
    mkdirSync(stateDir, { recursive: true });
    const malformed = "PRIVATE_SENTINEL_CONFIG_CONTENT";
    writeFileSync(p.config, malformed);

    const result = runCli(stateDir, ["config", "set", "name", "Studio Mac"]);

    expect(result.status).toBe(2);
    expect(readFileSync(p.config, "utf8")).toBe(malformed);
    expect(`${result.stdout}${result.stderr}`).toContain(p.config);
    expect(`${result.stdout}${result.stderr}`).not.toContain("PRIVATE_");
  });
});
