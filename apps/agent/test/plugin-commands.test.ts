import { Command } from "commander";
import { afterEach, expect, it, vi } from "vitest";
import { addPluginCommands } from "../src/plugins/commands.js";
import type { PluginManager } from "../src/plugins/manager.js";
import { PluginError } from "../src/plugins/schema.js";

afterEach(() => vi.restoreAllMocks());
function fixture() {
  const manager = {
    list: vi.fn(async () => [{ id: "example", name: "Example", installed: false }]),
    install: vi.fn(async () => ({ id: "example", changed: true, localPreview: false })),
    uninstall: vi.fn(async () => ({ id: "example", changed: true })),
    close: vi.fn(),
  };
  const root = new Command().option("--json").exitOverride();
  addPluginCommands(root, { manager: () => manager as unknown as PluginManager });
  const output: string[] = [];
  vi.spyOn(console, "log").mockImplementation((line) => output.push(String(line)));
  return { manager, root, output };
}
it.each([{ args: [] }, { args: ["list"] }])(
  "lists JSON without starting a browser for %j",
  async ({ args }) => {
    const f = fixture();
    await f.root.parseAsync(["--json", "plugins", ...args], { from: "user" });
    expect(JSON.parse(f.output[0]!)).toEqual([
      { id: "example", name: "Example", installed: false },
    ]);
    expect(f.manager.install).not.toHaveBeenCalled();
    expect(f.manager.close).toHaveBeenCalledOnce();
  },
);
it("installs an explicitly chosen local provider preview", async () => {
  const f = fixture();
  await f.root.parseAsync(
    ["--json", "plugins", "install", "example", "--from-directory", "/example/package"],
    { from: "user" },
  );
  expect(f.manager.install).toHaveBeenCalledWith("example", "/example/package");
  expect(JSON.parse(f.output[0]!)).toMatchObject({ changed: true });
});
it("reports actionable errors as JSON and a failed exit status", async () => {
  const f = fixture(),
    prior = process.exitCode;
  try {
    process.exitCode = 0;
    f.manager.install.mockRejectedValue(
      new PluginError("missing-command", "Install Example first."),
    );
    await f.root.parseAsync(["--json", "plugins", "install", "example"], { from: "user" });
    expect(process.exitCode).toBe(1);
    expect(JSON.parse(f.output[0]!)).toEqual({
      error: { code: "missing-command", message: "Install Example first." },
    });
  } finally {
    process.exitCode = prior;
  }
});
