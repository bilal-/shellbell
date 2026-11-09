import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { crc32, deflateSync } from "node:zlib";
import { afterEach, expect, it, vi } from "vitest";
import { PluginManager } from "../src/plugins/manager.js";
import { digest, PluginPackages } from "../src/plugins/package.js";
import type { RegistryEntry } from "../src/plugins/schema.js";
import { PageRegistry } from "../src/web/page-registry.js";

const homes: string[] = [];
afterEach(() => {
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true });
});
const entry: RegistryEntry = {
  id: "example",
  name: "Example",
  description: "A local board",
  command: "example",
  repository: "acme/example",
  revision: "a".repeat(40),
  directory: "plugins/shellbell",
};
const manifest = {
  schemaVersion: 1,
  id: "example",
  version: "1.0.0",
  name: "Example",
  description: "A local board",
  homepage: "https://example.test",
  platforms: ["linux", "darwin"],
  requires: { command: "example", help: "Install Example first." },
  page: { name: "Example board", args: ["serve", "--json", "--port", "0"] },
};
function fixture(installed = true) {
  const home = mkdtempSync(join(tmpdir(), "shellbell-plugin-"));
  homes.push(home);
  const bin = join(home, "bin");
  mkdirSync(bin, { mode: 0o700 });
  const executable = join(bin, "example");
  if (installed) writeFileSync(executable, "not executed", { mode: 0o700 });
  const packageDir = join(home, "package");
  mkdirSync(packageDir, { mode: 0o700 });
  writeFileSync(join(packageDir, "shellbell-plugin.json"), JSON.stringify(manifest), {
    mode: 0o600,
  });
  const request = vi.fn<typeof fetch>(async () => new Response(JSON.stringify(manifest)));
  const manager = new PluginManager({
    home,
    env: { HOME: home, PATH: bin },
    catalog: [entry],
    platform: "linux",
    fetch: request,
  });
  const path = join(home, ".config/shellbell/apps/example.json");
  return { home, bin, executable, packageDir, request, manager, path };
}
it("lists an offline catalog without creating files, fetching GitHub or executing programs", async () => {
  const f = fixture();
  expect(await f.manager.list()).toMatchObject([
    { id: "example", installed: false, status: "available", executable: f.executable },
  ]);
  expect(f.request).not.toHaveBeenCalled();
  expect(existsSync(join(f.home, ".config"))).toBe(false);
  f.manager.close();
});
it("requires the external application before installing, with no download side effects", async () => {
  const f = fixture(false);
  await expect(f.manager.install("example")).rejects.toMatchObject({ code: "missing-command" });
  expect(f.request).not.toHaveBeenCalled();
  expect(existsSync(join(f.home, ".config"))).toBe(false);
});
it("installs the pinned repository manifest as a trusted page and is idempotent", async () => {
  const f = fixture();
  expect(await f.manager.install("example")).toMatchObject({ changed: true, localPreview: false });
  expect(f.request).toHaveBeenCalledWith(
    expect.stringContaining(
      `acme/example/contents/plugins/shellbell/shellbell-plugin.json?ref=${entry.revision}`,
    ),
    expect.objectContaining({ redirect: "error" }),
  );
  const record = JSON.parse(readFileSync(f.path, "utf8"));
  expect(record.start).toEqual([f.executable, ...manifest.page.args]);
  expect(record.shellbellPlugin.repository).toBe("acme/example");
  const registry = new PageRegistry({ home: f.home, platform: "linux", create: false });
  await registry.refresh();
  expect(registry.entries).toMatchObject([{ id: "example", name: "Example board" }]);
  registry.close();
  const before = statSync(f.path);
  expect(await f.manager.install("example")).toMatchObject({ changed: false });
  expect(statSync(f.path).mtimeMs).toBe(before.mtimeMs);
  expect(statSync(f.path).mode & 0o777).toBe(0o600);
  expect(await f.manager.list()).toMatchObject([
    { installed: true, status: "installed", version: "1.0.0" },
  ]);
});
it("uses an explicit local package preview without claiming it came from GitHub", async () => {
  const f = fixture();
  await f.manager.install("example", f.packageDir);
  expect(f.request).not.toHaveBeenCalled();
  expect(await f.manager.list()).toMatchObject([{ localPreview: true }]);
});

it("explains unsafe local package permissions before a fresh home has .config", async () => {
  const f = fixture();
  chmodSync(f.packageDir, 0o770);
  await expect(f.manager.info("example", f.packageDir)).rejects.toMatchObject({
    message: expect.stringContaining("can be changed by other users"),
    fix: expect.stringContaining("chmod g-w"),
  });
  expect(existsSync(join(f.home, ".config"))).toBe(false);
  expect(f.request).not.toHaveBeenCalled();
});
it("preserves manual registrations and customized managed configuration", async () => {
  const f = fixture();
  await f.manager.install("example");
  const value = JSON.parse(readFileSync(f.path, "utf8"));
  value.name = "My board";
  writeFileSync(f.path, JSON.stringify(value));
  f.request.mockClear();
  await expect(f.manager.install("example")).rejects.toMatchObject({ code: "customized" });
  expect(f.request).not.toHaveBeenCalled();
  expect(JSON.parse(readFileSync(f.path, "utf8")).name).toBe("My board");
  delete value.shellbellPlugin;
  writeFileSync(f.path, JSON.stringify(value));
  await expect(f.manager.uninstall("example")).rejects.toMatchObject({ code: "custom-page" });
  await expect(f.manager.install("example")).rejects.toMatchObject({ code: "custom-page" });
});
it("reuses a reviewed pinned package during the same browser session", async () => {
  const f = fixture();
  await f.manager.info("example");
  await f.manager.install("example");
  expect(f.request).toHaveBeenCalledTimes(1);
});
it("repairs a missing managed icon without rewriting its registration", async () => {
  const f = fixture();
  const chunk = (tag: string, bytes: Buffer) => {
    const out = Buffer.alloc(bytes.length + 12);
    out.writeUInt32BE(bytes.length);
    out.write(tag, 4);
    bytes.copy(out, 8);
    out.writeUInt32BE(crc32(out.subarray(4, -4)), out.length - 4);
    return out;
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(1);
  header.writeUInt32BE(1, 4);
  header[8] = 8;
  header[9] = 6;
  const icon = Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk("IHDR", header),
    chunk("IDAT", deflateSync(Buffer.from([0, 0, 0, 0, 255]))),
    chunk("IEND", Buffer.alloc(0)),
  ]);
  writeFileSync(join(f.packageDir, "icon.png"), icon, { mode: 0o600 });
  writeFileSync(
    join(f.packageDir, "shellbell-plugin.json"),
    JSON.stringify({ ...manifest, icon: { file: "icon.png", sha256: digest(icon) } }),
  );
  await f.manager.install("example", f.packageDir);
  const record = JSON.parse(readFileSync(f.path, "utf8"));
  const before = statSync(f.path, { bigint: true }).mtimeNs;
  rmSync(record.icon);
  expect(await f.manager.install("example", f.packageDir)).toMatchObject({ changed: true });
  expect(readFileSync(record.icon)).toEqual(icon);
  expect(statSync(f.path, { bigint: true }).mtimeNs).toBe(before);
  writeFileSync(record.icon, "damaged");
  await expect(f.manager.install("example", f.packageDir)).rejects.toThrow();
  expect(readFileSync(record.icon, "utf8")).toBe("damaged");
});
it.each([
  [429, "rate-limited"],
  [403, "access-denied"],
  [500, "github-unavailable"],
  [400, "download-failed"],
])("reports HTTP %s without calling it an unpublished package", async (status, code) => {
  const f = fixture();
  f.request.mockImplementation(async () => new Response("refused", { status: Number(status) }));
  await expect(f.manager.install("example")).rejects.toMatchObject({ code });
});
it("uninstalls only its registration and leaves the program and other pages intact", async () => {
  const f = fixture();
  await f.manager.install("example");
  const other = join(f.home, ".config/shellbell/apps/other.json");
  writeFileSync(other, "{}");
  expect(await f.manager.uninstall("example")).toEqual({ id: "example", changed: true });
  expect(existsSync(f.path)).toBe(false);
  expect(existsSync(f.executable)).toBe(true);
  expect(existsSync(other)).toBe(true);
  expect(await f.manager.uninstall("example")).toEqual({ id: "example", changed: false });
});
it("refuses symlinked registrations and unsafe parents without changing them", async () => {
  const f = fixture();
  await f.manager.install("example");
  rmSync(f.path);
  const target = join(f.home, "keep");
  writeFileSync(target, "keep");
  symlinkSync(target, f.path);
  await expect(f.manager.uninstall("example")).rejects.toThrow();
  expect(readFileSync(target, "utf8")).toBe("keep");
  rmSync(f.path);
  chmodSync(join(f.home, ".config"), 0o770);
  await expect(f.manager.install("example")).rejects.toThrow();
  expect(statSync(join(f.home, ".config")).mode & 0o777).toBe(0o770);
});
it("rejects unknown plugins and packages that disagree with the registry", async () => {
  const f = fixture();
  await expect(f.manager.install("unknown")).rejects.toMatchObject({ code: "unknown-plugin" });
  f.request.mockImplementation(
    async () =>
      new Response(JSON.stringify({ ...manifest, requires: { command: "sh", help: "anything" } })),
  );
  await expect(f.manager.install("example")).rejects.toMatchObject({ code: "invalid-package" });
  expect(existsSync(join(f.home, ".config"))).toBe(false);
});
it("bounds remote responses and reports unpublished pins without writing state", async () => {
  const f = fixture();
  f.request.mockImplementation(async () => new Response("not yet published", { status: 404 }));
  await expect(f.manager.install("example")).rejects.toMatchObject({ code: "package-unavailable" });
  f.request.mockImplementation(async () => new Response("x".repeat(16385)));
  await expect(f.manager.install("example")).rejects.toMatchObject({ code: "package-too-large" });
  expect(existsSync(join(f.home, ".config"))).toBe(false);
});
it("rejects a corrupt icon and traversal in provider filenames", async () => {
  const f = fixture();
  const files = new PageRegistry({ home: f.home, create: false, platform: "linux" });
  let input = { ...manifest, icon: { file: "icon.png", sha256: digest("not PNG") } };
  const request = vi.fn<typeof fetch>(
    async (url) =>
      new Response(String(url).includes("icon.png") ? "not PNG" : JSON.stringify(input)),
  );
  const packages = new PluginPackages({ files, fetch: request });
  await expect(packages.load(entry)).rejects.toMatchObject({ code: "invalid-icon" });
  input = { ...manifest, icon: { file: "../secret", sha256: digest("not PNG") } };
  await expect(packages.load(entry)).rejects.toMatchObject({ code: "invalid-package" });
  expect(request).toHaveBeenCalledTimes(3);
});
it("refuses a full page catalog without replacing existing registrations", async () => {
  const f = fixture(),
    directory = join(f.home, ".config/shellbell/apps");
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  for (let n = 0; n < 16; n++)
    writeFileSync(
      join(directory, `page-${n}.json`),
      JSON.stringify({ shellbell: 1, name: `Page ${n}`, url: "http://127.0.0.1:3000/" }),
      { mode: 0o600 },
    );
  await expect(f.manager.install("example")).rejects.toThrow("page limit");
  expect(existsSync(f.path)).toBe(false);
});
it("cancels a pending provider download on close without publishing a registration", async () => {
  const f = fixture();
  let signal: AbortSignal | undefined;
  f.request.mockImplementation(
    (_url, options) =>
      new Promise((_resolve, reject) => {
        signal = options?.signal ?? undefined;
        signal?.addEventListener("abort", () => reject(new Error("cancelled")), { once: true });
      }),
  );
  const pending = f.manager.install("example");
  await vi.waitFor(() => expect(signal).toBeDefined());
  f.manager.close();
  await expect(pending).rejects.toThrow();
  expect(existsSync(f.path)).toBe(false);
});
it("detects nested owner customizations before reinstalling", async () => {
  const f = fixture();
  await f.manager.install("example");
  const record = JSON.parse(readFileSync(f.path, "utf8"));
  record.owner = { preferences: { theme: "light" } };
  writeFileSync(f.path, JSON.stringify(record));
  await expect(f.manager.install("example")).rejects.toMatchObject({ code: "customized" });
  expect(JSON.parse(readFileSync(f.path, "utf8")).owner.preferences.theme).toBe("light");
});

it("keeps an installed application discoverable when the invoking PATH changes", async () => {
  const f = fixture();
  await f.manager.install("example");
  const other = new PluginManager({
    home: f.home,
    env: { HOME: f.home, PATH: "" },
    catalog: [entry],
    platform: "linux",
    fetch: f.request,
  });
  expect(await other.list()).toMatchObject([
    { installed: true, available: true, executable: f.executable, status: "installed" },
  ]);
  other.close();
});
