import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { generateIdentity, identityToJson } from "@shellbell/protocol";
import { Command } from "commander";
import { afterEach, expect, it, vi } from "vitest";
import { resolveLinuxPaths } from "../src/host-paths.js";
import { inspectLinuxState } from "../src/host-state.js";
import { config, fixture } from "./host-fixtures.js";

afterEach(() => {
  vi.restoreAllMocks();
  process.exitCode = 0;
});

async function command(platform: NodeJS.Platform = "linux") {
  const module = await import("../src/host-command.js").catch(() => ({}));
  expect(module).toHaveProperty("addHostCommand");
  const { addHostCommand } = module as typeof import("../src/host-command.js");
  const f = fixture();
  const p = resolveLinuxPaths(f.options);
  const select = vi.fn(() => p);
  const output: string[] = [];
  vi.spyOn(console, "log").mockImplementation((line) => output.push(String(line)));
  vi.spyOn(console, "error").mockImplementation((line) => output.push(String(line)));
  const root = new Command().option("--json").exitOverride();
  addHostCommand(root, { platform, selectPaths: select, hostname: () => "" });
  return { root, p, select, output };
}

it("explicit new initialization creates ready state without starting services or pairing", async () => {
  const { root, p, output } = await command();
  await root.parseAsync(["--json", "host", "init", "--new"], { from: "user" });
  expect(inspectLinuxState(p).status).toBe("ready");
  expect(JSON.parse(readFileSync(p.config, "utf8")).computerName).toBe("Linux");
  expect(existsSync(p.sock)).toBe(false);
  expect(existsSync(p.pid)).toBe(false);
  expect(JSON.parse(output[0]!)).toMatchObject({ status: "initialized", next: "shellbell start" });
  expect(output.join(" ")).not.toContain(p.linuxHost.hostDigest);
  const original = readFileSync(p.identity);
  await root.parseAsync(["--json", "host", "init", "--new"], { from: "user" });
  expect(JSON.parse(output[1]!)).toMatchObject({ status: "already-initialized" });
  expect(readFileSync(p.identity)).toEqual(original);
});

it.each([
  [],
  ["--new", "--adopt", "/source", "--confirm-source-inactive"],
  ["--adopt", "/source"],
  ["--adopt", "relative", "--confirm-source-inactive"],
  ["--new", "--confirm-source-inactive"],
])(
  "rejects invalid initialization arguments before selecting state: %j",
  async (...args: string[]) => {
    const { root, p, select } = await command();
    await root.parseAsync(["host", "init", ...args], { from: "user" });
    expect(process.exitCode).toBe(2);
    expect(select).not.toHaveBeenCalled();
    expect(existsSync(p.dir)).toBe(false);
  },
);

it("rejects macOS invocation without selecting Linux state", async () => {
  const { root, select } = await command("darwin");
  await root.parseAsync(["host", "init", "--new"], { from: "user" });
  expect(process.exitCode).toBe(2);
  expect(select).not.toHaveBeenCalled();
});

it("explicit adoption preserves source bytes and its existing name", async () => {
  const { root, p, output } = await command();
  const f = fixture();
  const source = join(f.root, "source");
  mkdirSync(source, { mode: 0o700 });
  const originals = {
    "identity.json": JSON.stringify(identityToJson(generateIdentity()), null, 2),
    "config.json": JSON.stringify({ ...config, computerName: "Original computer" }, null, 2),
    "pairings.json": '{"v":1,"phones":[]}\n',
  };
  for (const [name, bytes] of Object.entries(originals))
    writeFileSync(join(source, name), bytes, { mode: 0o600 });
  await root.parseAsync(
    ["--json", "host", "init", "--adopt", source, "--confirm-source-inactive"],
    { from: "user" },
  );
  expect(JSON.parse(output[0]!)).toMatchObject({ status: "initialized" });
  for (const [name, bytes] of Object.entries(originals)) {
    expect(readFileSync(join(p.dir, name), "utf8")).toBe(bytes);
    expect(readFileSync(join(source, name), "utf8")).toBe(bytes);
  }
  expect(existsSync(p.sock)).toBe(false);
  expect(existsSync(p.pid)).toBe(false);
});
