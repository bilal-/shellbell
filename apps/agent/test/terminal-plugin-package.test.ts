import { spawnSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, expect, it } from "vitest";
import { importTerminalPlugin } from "../runtime/terminal-plugin-loader.mjs";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
function fixture(target = "runtime/terminal-plugin-loader.mjs") {
  const root = mkdtempSync(join(tmpdir(), "sb-plugin-package-"));
  roots.push(root);
  mkdirSync(join(root, "dist"));
  mkdirSync(join(root, "runtime"));
  writeFileSync(
    join(root, "package.json"),
    JSON.stringify({
      type: "module",
      imports: { "#terminal-plugin-loader": `./${target}` },
    }),
  );
  writeFileSync(
    join(root, "dist/cli.js"),
    'export { importTerminalPlugin } from "#terminal-plugin-loader";\n',
  );
  cpSync(resolve("runtime/terminal-plugin-loader.mjs"), join(root, target));
  return root;
}
function verify(root: string) {
  const result = spawnSync(
    process.execPath,
    ["--experimental-import-meta-resolve", resolve("../macos/scripts/verify-imports.mjs"), root],
    { encoding: "utf8", timeout: 15_000, maxBuffer: 64 * 1024 },
  );
  return { status: result.status, output: `${result.stdout}${result.stderr}` };
}
it("qualifies the pinned local plugin boundary and loads a real owner-selected ESM entry", async () => {
  const root = fixture();
  expect(verify(root)).toMatchObject({ status: 0 });
  const plugin = join(root, "example.mjs");
  writeFileSync(plugin, 'export default { id: "example" };\n', { mode: 0o600 });
  const loader = await import(pathToFileURL(join(root, "dist/cli.js")).href);
  expect((await loader.importTerminalPlugin(pathToFileURL(plugin).href)).default).toEqual({
    id: "example",
  });
});
it("refuses altered loader bytes and copies outside the declared runtime boundary", () => {
  const root = fixture();
  const file = join(root, "runtime/terminal-plugin-loader.mjs");
  writeFileSync(file, `${readFileSync(file, "utf8")}\n`);
  expect(verify(root).status).not.toBe(0);
  expect(verify(fixture("runtime/other-loader.mjs")).status).not.toBe(0);
});
it("still refuses arbitrary computed imports elsewhere in the package", () => {
  const root = fixture();
  writeFileSync(join(root, "dist/cli.js"), 'const target = "./hidden.js"; import(target);\n');
  expect(verify(root)).toMatchObject({ status: 1 });
});
it.each([
  "https://example.test/plugin.mjs",
  "file://remote/plugin.mjs",
  "file:///plugin.mjs?query",
  "file:///plugin.mjs#hash",
])("refuses nonlocal or decorated plugin URL %s", async (url) => {
  await expect(importTerminalPlugin(url)).rejects.toThrow("plain local file URL");
});
