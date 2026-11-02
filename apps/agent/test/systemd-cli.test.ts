import { existsSync, readFileSync } from "node:fs";
import { Command } from "commander";
import { afterEach, expect, it, vi } from "vitest";
import { linuxBackground } from "../src/background.js";
import { addBackgroundCommands, startBackground } from "../src/background-commands.js";
import { hostile, integrationFixture, tree } from "./systemd-integration-fixture.js";

const exitCode = process.exitCode;
afterEach(() => {
  process.exitCode = exitCode;
  expect(hostile).not.toHaveBeenCalled();
  vi.clearAllMocks();
});

const runtime = () => ({ nodePath: "/opt/node/bin/node", cliPath: "/opt/shellbell/dist/cli.js" });

async function cli(
  f: Awaited<ReturnType<typeof integrationFixture>>,
  command: string,
  json = true,
  extra: { otherCopyRunning?: boolean; ensureHost?: () => Promise<void> } = {},
) {
  const output: string[] = [];
  vi.spyOn(console, "log").mockImplementation((line) => output.push(String(line)));
  vi.spyOn(console, "error").mockImplementation((line) => output.push(String(line)));
  const p = new Command()
    .option("--json")
    .option("--relay <url>")
    .exitOverride()
    .configureOutput({ writeErr: () => {} });
  const deps = {
    background: () => linuxBackground(f.lifecycle, extra.ensureHost ?? (async () => {}), runtime),
    version: "test",
    otherCopyRunning: async () => extra.otherCopyRunning ?? false,
  };
  addBackgroundCommands(p, deps);
  // The CLI's own `start` hands an installed Shellbell to startBackground.
  p.command("start").action(async () => {
    process.exitCode = await startBackground(deps, json);
  });
  await p.parseAsync(["--relay", "wss://ignored.invalid", ...(json ? ["--json"] : []), command], {
    from: "user",
  });
  return {
    code: process.exitCode,
    output: output.join("\n"),
    result: json ? JSON.parse(output[0]!) : null,
  };
}

it("install sets up, turns on start-at-login and starts in one step; stop, start and uninstall follow", async () => {
  const f = await integrationFixture();
  const identity = readFileSync(f.selected.identity);
  const config = readFileSync(f.selected.config);
  const installed = await cli(f, "install");
  expect(installed.code).toBe(0);
  expect(installed.result).toMatchObject({
    installed: true,
    running: true,
    startsAtLogin: true,
    version: "test",
  });
  expect(f.calls).toContain("start");

  const stopped = await cli(f, "stop", false);
  expect(stopped.code).toBe(0);
  expect(stopped.output).toMatch(/starts again the next time you log in/);
  expect((await cli(f, "start")).result).toMatchObject({ running: true, startsAtLogin: true });
  expect((await cli(f, "restart")).code).toBe(0);

  const removed = await cli(f, "uninstall", false);
  expect(removed.code).toBe(0);
  expect(removed.output).toMatch(/phones stay paired/);
  expect(readFileSync(f.selected.identity)).toEqual(identity);
  expect(readFileSync(f.selected.config)).toEqual(config);
  expect(existsSync(f.location.definitionPath)).toBe(false);
});

it("install again while this version runs changes nothing", async () => {
  const f = await integrationFixture();
  await cli(f, "install");
  const before = tree(f.root);
  f.calls.length = 0;
  const again = await cli(f, "install", false);
  expect(again.code).toBe(0);
  expect(again.output).toMatch(/is running in the background/);
  expect(f.calls).not.toContain("stop");
  expect(f.calls).not.toContain("start");
  expect(tree(f.root)).toEqual(before);
});

it("says plainly that Shellbell stops at logout while linger is off", async () => {
  const f = await integrationFixture();
  const text = await cli(f, "install", false);
  expect(text.output).toMatch(/stops when you log out.*sudo loginctl enable-linger/);
  f.setLinger("yes");
  expect((await cli(f, "install", false)).output).not.toMatch(/log out/);
});

it("a computer without a systemd user session keeps its state as it was and says to use run", async () => {
  const f = await integrationFixture();
  f.observation.available = false;
  f.observation.activeState = "unknown";
  const before = tree(f.root);
  const ensureHost = vi.fn(async () => {});
  const result = await cli(f, "install", false, { ensureHost });
  expect(result.code).toBe(2);
  expect(result.output).toMatch(/can't run Shellbell in the background.*shellbell run/);
  expect(ensureHost).not.toHaveBeenCalled();
  expect(tree(f.root)).toEqual(before);
});

it("install refuses while another copy runs in a terminal window", async () => {
  const f = await integrationFixture();
  const result = await cli(f, "install", false, { otherCopyRunning: true });
  expect(result.code).toBe(2);
  expect(result.output).toMatch(/running in a terminal window. Press Ctrl-C/);
  expect(f.calls).not.toContain("start");
});

it("stop and uninstall with nothing installed say so and succeed", async () => {
  const f = await integrationFixture();
  for (const command of ["stop", "uninstall"]) {
    const result = await cli(f, command, false);
    expect(result.code).toBe(0);
    expect(result.output).toMatch(/doesn't run in the background/);
  }
  expect((await cli(f, "stop", false, { otherCopyRunning: true })).output).toMatch(
    /terminal window, not in the background/,
  );
});

it("status stays read-only and private", async () => {
  const f = await integrationFixture();
  await cli(f, "install");
  const before = tree(f.root);
  f.calls.length = 0;
  await f.lifecycle.status();
  expect(tree(f.root)).toEqual(before);
  expect(f.calls.every((v) => v === "observe" || v === "linger")).toBe(true);
});

it("uninstall reports remaining external autostart as incomplete", async () => {
  const f = await integrationFixture();
  await cli(f, "install");
  f.setExternalEnabled();
  const result = await cli(f, "uninstall", false);
  expect(result.code).toBe(2);
  expect(result.output).toMatch(/something else still starts it/);
});

it("refuses foreign manager ownership with an actionable, private failure", async () => {
  const f = await integrationFixture();
  await cli(f, "install");
  await cli(f, "stop");
  f.observation.dropInPaths = "/private/machine-secret.conf";
  f.calls.length = 0;
  const result = await cli(f, "start");
  expect(result.code).toBe(2);
  expect(result.result.error).toMatch(/ownership|foreign|manager/);
  expect(result.output).not.toContain("machine-secret");
  expect(f.calls).not.toContain("start");
});

it.each(["--help", "--version"])("%s does not construct a background", async (arg) => {
  const f = await integrationFixture();
  const before = tree(f.root);
  const p = new Command()
    .version("fixture")
    .exitOverride()
    .configureOutput({ writeOut: () => {} });
  addBackgroundCommands(p, { background: hostile, version: "test" });
  await expect(p.parseAsync([arg], { from: "user" })).rejects.toMatchObject({ exitCode: 0 });
  expect(tree(f.root)).toEqual(before);
});
