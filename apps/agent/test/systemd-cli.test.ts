import { existsSync, readFileSync } from "node:fs";
import { Command } from "commander";
import { afterEach, expect, it, vi } from "vitest";
import { addServiceCommands } from "../src/cli.js";
import { hostile, integrationFixture, tree } from "./systemd-integration-fixture.js";

const platform = Object.getOwnPropertyDescriptor(process, "platform")!;
const exitCode = process.exitCode;
afterEach(() => {
  Object.defineProperty(process, "platform", platform);
  process.exitCode = exitCode;
  expect(hostile).not.toHaveBeenCalled();
  vi.clearAllMocks();
});

async function cli(
  f: Awaited<ReturnType<typeof integrationFixture>>,
  command: string,
  json = true,
  platformName: NodeJS.Platform = "linux",
) {
  Object.defineProperty(process, "platform", { value: platformName, configurable: true });
  const output: string[] = [];
  vi.spyOn(console, "log").mockImplementation((line) => output.push(String(line)));
  vi.spyOn(console, "error").mockImplementation((line) => output.push(String(line)));
  const p = new Command()
    .option("--json")
    .option("--relay <url>")
    .exitOverride()
    .configureOutput({ writeErr: () => {} });
  addServiceCommands(p, hostile, {
    platform: platformName,
    createLinuxLifecycle: () => f.lifecycle,
  });
  await p.parseAsync(
    ["--relay", "wss://ignored.invalid", ...(json ? ["--json"] : []), "service", command],
    { from: "user" },
  );
  return {
    code: process.exitCode,
    output: output.join("\n"),
    result: json ? JSON.parse(output[0]!) : null,
  };
}

it("installs without starting or enabling, then explicitly starts/enables/stops/disables/uninstalls", async () => {
  const f = await integrationFixture();
  const identity = readFileSync(f.selected.identity);
  const config = readFileSync(f.selected.config);
  expect((await cli(f, "install")).result).toMatchObject({
    manager: "systemd",
    installed: true,
    ready: false,
    enabled: false,
  });
  expect(process.exitCode).toBe(0);
  expect(f.calls).not.toContain("start");
  expect((await cli(f, "status")).code).toBe(2);
  expect((await cli(f, "enable")).result).toMatchObject({ enabled: true, ready: false });
  expect(process.exitCode).toBe(0);
  expect(f.calls).not.toContain("start");
  expect((await cli(f, "start")).result).toMatchObject({ ready: true, enabled: true });
  expect((await cli(f, "restart")).code).toBe(0);
  const stopped = await cli(f, "stop", false);
  expect(stopped.code).toBe(0);
  expect(stopped.output).toMatch(/future.*enabled|autostart.*enabled/i);
  expect(stopped.output).toMatch(/linger.*no/i);
  expect((await cli(f, "disable")).result).toMatchObject({ enabled: false, ready: false });
  expect((await cli(f, "uninstall")).result.installed).toBe(false);
  expect(readFileSync(f.selected.identity)).toEqual(identity);
  expect(readFileSync(f.selected.config)).toEqual(config);
  expect(existsSync(f.location.definitionPath)).toBe(false);
});

it("status is read-only and private; remaining external enablement makes disable nonzero", async () => {
  const f = await integrationFixture();
  await cli(f, "install");
  await cli(f, "enable");
  const before = tree(f.root);
  f.calls.length = 0;
  const status = await cli(f, "status");
  expect(tree(f.root)).toEqual(before);
  expect(f.calls.every((v) => v === "observe" || v === "linger")).toBe(true);
  expect(status.output).not.toContain(f.machine.machineId);
  f.setExternalEnabled();
  const disabled = await cli(f, "disable");
  expect(disabled.code).toBe(2);
  expect(disabled.result).toMatchObject({ enabled: true, autostartConfigured: false });
  expect(disabled.output).toMatch(/external.*enablement/i);
});

it.each(["enable", "disable"])(
  "%s rejects an unsupported platform without invoking either manager",
  async (command) => {
    const f = await integrationFixture();
    const before = tree(f.root);
    const result = await cli(f, command, true, "win32");
    expect(result.code).toBe(2);
    expect(result.result.error).toMatch(/macOS.*Linux/);
    expect(f.calls).toEqual([]);
    expect(tree(f.root)).toEqual(before);
  },
);

it("unsupported platforms fail explicitly without state writes", async () => {
  const f = await integrationFixture();
  const before = tree(f.root);
  expect((await cli(f, "install", true, "win32")).code).toBe(2);
  expect(f.calls).toEqual([]);
  expect(tree(f.root)).toEqual(before);
});

it("uninstall reports remaining external autostart as incomplete revocation", async () => {
  const f = await integrationFixture();
  await cli(f, "install");
  f.setExternalEnabled();
  const result = await cli(f, "uninstall");
  expect(result.code).toBe(2);
  expect(result.result).toMatchObject({ installed: false, enabled: true });
});

it("refuses foreign manager ownership with an actionable, private failure", async () => {
  const f = await integrationFixture();
  await cli(f, "install");
  f.observation.dropInPaths = "/private/machine-secret.conf";
  const result = await cli(f, "start");
  expect(result.code).toBe(2);
  expect(result.result.error).toMatch(/ownership|foreign|manager/);
  expect(result.output).not.toContain("machine-secret");
  expect(f.calls).not.toContain("start");
});

it.each(["--help", "--version"])("%s does not construct either lifecycle", async (arg) => {
  const f = await integrationFixture();
  const before = tree(f.root);
  const p = new Command()
    .version("fixture")
    .exitOverride()
    .configureOutput({ writeOut: () => {} });
  addServiceCommands(p, hostile, { platform: "linux", createLinuxLifecycle: hostile });
  await expect(p.parseAsync([arg], { from: "user" })).rejects.toMatchObject({ exitCode: 0 });
  expect(tree(f.root)).toEqual(before);
});
