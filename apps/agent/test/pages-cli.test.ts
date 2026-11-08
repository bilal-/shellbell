import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Command } from "commander";
import { afterEach, expect, it, vi } from "vitest";
import { addPagesCommand } from "../src/cli.js";
import { pageChecks } from "../src/doctor.js";

const homes: string[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true });
});
function home(): string {
  const p = mkdtempSync(join(tmpdir(), "shellbell-pages-cli-"));
  homes.push(p);
  return p;
}
async function list(root: string): Promise<string> {
  const output: string[] = [];
  vi.spyOn(console, "log").mockImplementation((line) => output.push(String(line)));
  const command = new Command().option("--json");
  command.exitOverride();
  addPagesCommand(command, root);
  await command.parseAsync(["--json", "pages"], { from: "user" });
  return output.join("\n");
}
it("listing and doctor never create page folders", async () => {
  const h = home();
  expect(JSON.parse(await list(h)).pages).toEqual([]);
  await pageChecks(h);
  expect(existsSync(join(h, ".config"))).toBe(false);
});
it("reports unsafe parents without changing their permissions", async () => {
  const h = home(),
    config = join(h, ".config");
  mkdirSync(join(config, "shellbell/apps"), { recursive: true, mode: 0o700 });
  chmodSync(config, 0o770);
  expect(await list(h)).toContain("chmod g-w ~/.config");
  expect(JSON.stringify(await pageChecks(h))).toContain("chmod g-w ~/.config");
  expect(statSync(config).mode & 0o777).toBe(0o770);
});
it("describes commands without running them or printing private arguments", async () => {
  const h = home(),
    dir = join(h, ".config/shellbell/apps");
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  writeFileSync(
    join(dir, "board.json"),
    JSON.stringify({
      shellbell: 1,
      name: "Board",
      start: [process.execPath, "--eval", "PRIVATE_START_ARGUMENT"],
    }),
    { mode: 0o600 },
  );
  const output = await list(h);
  expect(JSON.parse(output).pages).toEqual([{ id: "board", name: "Board" }]);
  expect(output).not.toContain("PRIVATE_START_ARGUMENT");
  expect((await pageChecks(h))[0]).toMatchObject({ severity: "pass" });
});
