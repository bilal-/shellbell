import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { plistFor } from "../src/launchd.js";
import { resolveServiceRuntime } from "../src/service-runtime.js";

type Fixture = {
  root: string;
  nodePath: string;
  packageRoot: string;
  cliPath: string;
};

const cleanupRoots: string[] = [];
const originalLowerCache = process.env.npm_config_cache;
const originalUpperCache = process.env.NPM_CONFIG_CACHE;

function ownedTemp(parent = process.cwd(), prefix = ".service-runtime-test-"): string {
  const root = mkdtempSync(join(parent, prefix));
  cleanupRoots.push(root);
  return root;
}

function createFixture(
  options: { parent?: string; prefix?: string; manifest?: unknown; manifestText?: string } = {},
): Fixture {
  const root = ownedTemp(options.parent, options.prefix);
  const nodePath = join(root, "node", "bin", "node");
  const packageRoot = join(root, "shellbell");
  const cliPath = join(packageRoot, "dist", "cli.js");
  mkdirSync(dirname(nodePath), { recursive: true });
  mkdirSync(dirname(cliPath), { recursive: true });
  writeFileSync(nodePath, "#!/bin/sh\n", { mode: 0o755 });
  writeFileSync(cliPath, "#!/usr/bin/env node\n", { mode: 0o644 });
  const manifest = options.manifest ?? { name: "shellbell", bin: { shellbell: "dist/cli.js" } };
  writeFileSync(
    join(packageRoot, "package.json"),
    options.manifestText ?? `${JSON.stringify(manifest)}\n`,
  );
  return { root, nodePath, packageRoot, cliPath };
}

afterEach(() => {
  if (originalLowerCache === undefined) delete process.env.npm_config_cache;
  else process.env.npm_config_cache = originalLowerCache;
  if (originalUpperCache === undefined) delete process.env.NPM_CONFIG_CACHE;
  else process.env.NPM_CONFIG_CACHE = originalUpperCache;
  for (const root of cleanupRoots.splice(0).reverse())
    rmSync(root, { force: true, recursive: true });
});

describe("resolveServiceRuntime", () => {
  it("returns canonical paths for an executable Node and readable installed CLI", () => {
    const fixture = createFixture();

    expect(resolveServiceRuntime(fixture.nodePath, fixture.cliPath)).toEqual({
      nodePath: realpathSync(fixture.nodePath),
      cliPath: realpathSync(fixture.cliPath),
      packageRoot: realpathSync(fixture.packageRoot),
    });
  });

  it.each([
    ["string", "dist/cli.js"],
    ["string with leading dot", "./dist/cli.js"],
    ["object", { shellbell: "dist/cli.js" }],
    ["object with leading dot", { shellbell: "./dist/cli.js" }],
  ])("accepts the package bin relationship expressed as %s", (_name, bin) => {
    const fixture = createFixture({ manifest: { name: "shellbell", bin } });
    expect(resolveServiceRuntime(fixture.nodePath, fixture.cliPath).cliPath).toBe(
      realpathSync(fixture.cliPath),
    );
  });

  it("accepts a durable bin symlink and persists its canonical CLI target", () => {
    const fixture = createFixture();
    const binPath = join(fixture.root, "bin", "shellbell");
    mkdirSync(dirname(binPath), { recursive: true });
    symlinkSync(fixture.cliPath, binPath);

    expect(resolveServiceRuntime(fixture.nodePath, binPath).cliPath).toBe(
      realpathSync(fixture.cliPath),
    );
  });

  it("accepts spaces and XML metacharacters while plistFor safely escapes canonical paths", () => {
    const fixture = createFixture({ prefix: ".service runtime & <-" });
    const runtime = resolveServiceRuntime(fixture.nodePath, fixture.cliPath);
    const xml = plistFor({ ...runtime, logPath: join(fixture.root, "agent & <.log") });

    expect(xml).toContain(runtime.nodePath.replaceAll("&", "&amp;").replaceAll("<", "&lt;"));
    expect(xml).toContain(runtime.cliPath.replaceAll("&", "&amp;").replaceAll("<", "&lt;"));
    expect(xml).not.toContain(runtime.nodePath);
    expect(xml).not.toContain(runtime.cliPath);
  });

  it.each(["node", "cli"])("rejects a relative %s path", (kind) => {
    const fixture = createFixture();
    const nodePath = kind === "node" ? relative(process.cwd(), fixture.nodePath) : fixture.nodePath;
    const cliPath = kind === "cli" ? relative(process.cwd(), fixture.cliPath) : fixture.cliPath;
    expect(() => resolveServiceRuntime(nodePath, cliPath)).toThrow(/absolute/i);
  });

  it.each(["node", "cli"])("rejects a missing %s file", (kind) => {
    const fixture = createFixture();
    const nodePath = kind === "node" ? join(fixture.root, "missing-node") : fixture.nodePath;
    const cliPath = kind === "cli" ? join(fixture.root, "missing-cli") : fixture.cliPath;
    expect(() => resolveServiceRuntime(nodePath, cliPath)).toThrow(/does not exist|missing/i);
  });

  it.each(["node", "cli"])("rejects a directory used as the %s file", (kind) => {
    const fixture = createFixture();
    const directory = join(fixture.root, `${kind}-directory`);
    mkdirSync(directory);
    const nodePath = kind === "node" ? directory : fixture.nodePath;
    const cliPath = kind === "cli" ? directory : fixture.cliPath;
    expect(() => resolveServiceRuntime(nodePath, cliPath)).toThrow(/regular file/i);
  });

  it("rejects a non-executable Node file", () => {
    const fixture = createFixture();
    chmodSync(fixture.nodePath, 0o644);
    expect(() => resolveServiceRuntime(fixture.nodePath, fixture.cliPath)).toThrow(/executable/i);
  });

  it("rejects an unreadable CLI file", () => {
    const fixture = createFixture();
    chmodSync(fixture.cliPath, 0o000);
    expect(() => resolveServiceRuntime(fixture.nodePath, fixture.cliPath)).toThrow(/readable/i);
  });

  it("rejects a TypeScript source entrypoint", () => {
    const fixture = createFixture();
    const sourceCli = join(fixture.packageRoot, "src", "cli.ts");
    mkdirSync(dirname(sourceCli), { recursive: true });
    writeFileSync(sourceCli, "export {};\n");
    expect(() => resolveServiceRuntime(fixture.nodePath, sourceCli)).toThrow(/built|installed/i);
  });

  it("rejects the built output of a source checkout", () => {
    const fixture = createFixture();
    const sourceCli = join(fixture.packageRoot, "src", "cli.ts");
    mkdirSync(dirname(sourceCli), { recursive: true });
    writeFileSync(sourceCli, "export {};\n");
    expect(() => resolveServiceRuntime(fixture.nodePath, fixture.cliPath)).toThrow(
      /source checkout/i,
    );
  });

  it("rejects a package with the wrong name", () => {
    const fixture = createFixture({
      manifest: { name: "not-shellbell", bin: { shellbell: "dist/cli.js" } },
    });
    expect(() => resolveServiceRuntime(fixture.nodePath, fixture.cliPath)).toThrow(/package name/i);
  });

  it("rejects a missing package manifest", () => {
    const fixture = createFixture();
    rmSync(join(fixture.packageRoot, "package.json"));
    expect(() => resolveServiceRuntime(fixture.nodePath, fixture.cliPath)).toThrow(
      /package\.json/i,
    );
  });

  it("rejects a directory used as the package manifest", () => {
    const fixture = createFixture();
    const manifestPath = join(fixture.packageRoot, "package.json");
    rmSync(manifestPath);
    mkdirSync(manifestPath);
    expect(() => resolveServiceRuntime(fixture.nodePath, fixture.cliPath)).toThrow(/regular file/i);
  });

  it("reports an unreadable package manifest without treating its contents as JSON diagnostics", () => {
    const fixture = createFixture();
    chmodSync(join(fixture.packageRoot, "package.json"), 0o000);
    expect(() => resolveServiceRuntime(fixture.nodePath, fixture.cliPath)).toThrow(/readable/i);
  });

  it("rejects malformed manifest JSON without exposing its contents", () => {
    const sentinel = "PRIVATE_MANIFEST_SENTINEL";
    const fixture = createFixture({ manifestText: `{ invalid ${sentinel}` });
    let message = "";
    try {
      resolveServiceRuntime(fixture.nodePath, fixture.cliPath);
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toMatch(/package\.json|manifest/i);
    expect(message).not.toContain(sentinel);
  });

  it("rejects a manifest larger than 1 MiB before reading it", () => {
    const fixture = createFixture();
    writeFileSync(join(fixture.packageRoot, "package.json"), " ".repeat(1024 * 1024 + 1));
    expect(() => resolveServiceRuntime(fixture.nodePath, fixture.cliPath)).toThrow(/1 MiB|large/i);
  });

  it.each([
    ["missing bin", { name: "shellbell" }],
    ["wrong string target", { name: "shellbell", bin: "dist/other.js" }],
    ["wrong object key", { name: "shellbell", bin: { other: "dist/cli.js" } }],
    ["wrong object target", { name: "shellbell", bin: { shellbell: "src/cli.ts" } }],
  ])("rejects a manifest with %s", (_name, manifest) => {
    const fixture = createFixture({ manifest });
    expect(() => resolveServiceRuntime(fixture.nodePath, fixture.cliPath)).toThrow(
      /bin|entrypoint/i,
    );
  });

  it.each([".npm", "_npx", "dlx"])("rejects the exact cache path component %s", (component) => {
    const container = ownedTemp(process.cwd(), ".service-runtime-components-");
    const parent = join(container, component);
    mkdirSync(parent);
    const fixture = createFixture({ parent });
    expect(() => resolveServiceRuntime(fixture.nodePath, fixture.cliPath)).toThrow(
      /temporary|cache/i,
    );
  });

  it.each(["attempts", "my-dlx-tools", "pnpm-global"])(
    "does not reject a durable directory merely because its name is %s",
    (component) => {
      const container = ownedTemp(process.cwd(), ".service-runtime-components-");
      const parent = join(container, component);
      mkdirSync(parent);
      const fixture = createFixture({ parent });
      expect(resolveServiceRuntime(fixture.nodePath, fixture.cliPath).packageRoot).toBe(
        realpathSync(fixture.packageRoot),
      );
    },
  );

  it.each(["npm_config_cache", "NPM_CONFIG_CACHE"] as const)(
    "rejects a runtime contained by the absolute %s root",
    (name) => {
      const cacheRoot = ownedTemp(process.cwd(), ".service-runtime-cache-");
      process.env[name] = cacheRoot;
      const fixture = createFixture({ parent: cacheRoot });
      expect(() => resolveServiceRuntime(fixture.nodePath, fixture.cliPath)).toThrow(
        /temporary|cache/i,
      );
    },
  );

  it("ignores a relative npm cache environment value", () => {
    process.env.npm_config_cache = "relative-cache";
    const fixture = createFixture();
    expect(resolveServiceRuntime(fixture.nodePath, fixture.cliPath).packageRoot).toBe(
      realpathSync(fixture.packageRoot),
    );
  });

  it("resolves an existing symlink used as the npm cache root", () => {
    const cacheTarget = ownedTemp(process.cwd(), ".service-runtime-cache-target-");
    const cacheLinkContainer = ownedTemp(process.cwd(), ".service-runtime-cache-link-");
    const cacheLink = join(cacheLinkContainer, "cache");
    symlinkSync(cacheTarget, cacheLink);
    process.env.npm_config_cache = cacheLink;
    const fixture = createFixture({ parent: cacheTarget });
    expect(() => resolveServiceRuntime(fixture.nodePath, fixture.cliPath)).toThrow(
      /temporary|cache/i,
    );
  });

  it.each(["/tmp", "/private/tmp", "/var/tmp", "/private/var/tmp"])(
    "rejects containment in the known temporary root %s before file lookup",
    (root) => {
      const fixture = createFixture();
      expect(() =>
        resolveServiceRuntime(join(root, "shellbell-test-node"), fixture.cliPath),
      ).toThrow(/temporary|cache/i);
    },
  );

  it.each(["node", "cli"])("rejects an invoked %s symlink inside the OS temp directory", (kind) => {
    const fixture = createFixture();
    const tempRoot = ownedTemp(tmpdir(), "sb-service-runtime-");
    const link = join(tempRoot, kind);
    symlinkSync(kind === "node" ? fixture.nodePath : fixture.cliPath, link);
    const nodePath = kind === "node" ? link : fixture.nodePath;
    const cliPath = kind === "cli" ? link : fixture.cliPath;
    expect(() => resolveServiceRuntime(nodePath, cliPath)).toThrow(/temporary|cache/i);
  });

  it.each(["node", "cli"])(
    "rejects a %s whose canonical target is in the OS temp directory",
    (kind) => {
      const temporary = createFixture({ parent: tmpdir(), prefix: "sb-service-runtime-" });
      const durable = createFixture();
      const link = join(durable.root, `${kind}-link`);
      symlinkSync(kind === "node" ? temporary.nodePath : temporary.cliPath, link);
      const nodePath = kind === "node" ? link : durable.nodePath;
      const cliPath = kind === "cli" ? link : durable.cliPath;
      expect(() => resolveServiceRuntime(nodePath, cliPath)).toThrow(/temporary|cache/i);
    },
  );

  it("includes the failed path and durable built-package remedy without file contents", () => {
    const fixture = createFixture();
    rmSync(fixture.cliPath);
    expect(() => resolveServiceRuntime(fixture.nodePath, fixture.cliPath)).toThrow(
      new RegExp(
        `${fixture.cliPath}.*built Shellbell package.*durable directory.*service install`,
        "i",
      ),
    );
  });
});
