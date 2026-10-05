import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { inspectBundleRuntime } from "../src/native/bundle-runtime.js";
import type { ServiceCommand } from "../src/service-command.js";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
function fixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "sb-bundle-")));
  roots.push(root);
  const bundle = join(root, "Shellbell.app");
  const files = [
    "MacOS/Shellbell",
    "Info.plist",
    "Helpers/node",
    "Resources/runtime/LICENSE",
    "Resources/agent/dist/cli.js",
    "Resources/agent/dist/native-controller.js",
    "Resources/agent/dist/native-service.js",
    "Resources/agent/package.json",
  ];
  for (const file of files) {
    const path = join(bundle, "Contents", file);
    mkdirSync(join(path, ".."), { recursive: true, mode: 0o755 });
    writeFileSync(
      path,
      file.endsWith("package.json")
        ? JSON.stringify({ name: "shellbell", version: "1.0.0", type: "module", dependencies: {} })
        : "fixture",
      { mode: 0o755 },
    );
  }
  const run: ServiceCommand = async (exe, args) => ({
    exitCode: 0,
    stdout: Buffer.from(
      exe === "/usr/bin/plutil"
        ? JSON.stringify({
            CFBundleIdentifier: "sh.bilal.shellbell.host",
            CFBundleExecutable: "Shellbell",
            CFBundleShortVersionString: "1.0.0",
          })
        : args[0] === "-p"
          ? `${process.platform}:${process.arch}\n`
          : args[0] === "--version"
            ? "v22.23.1\n"
            : "1.0.0\n",
    ),
  });
  return { root, bundle, run };
}
it("admits fixed runtime scripts and matching bundle/package versions", async () => {
  const f = fixture();
  expect(await inspectBundleRuntime(f.bundle, { run: f.run })).toEqual({
    executable: join(f.bundle, "Contents/MacOS/Shellbell"),
    nodePath: join(f.bundle, "Contents/Helpers/node"),
    controllerPath: join(f.bundle, "Contents/Resources/agent/dist/native-controller.js"),
    servicePath: join(f.bundle, "Contents/Resources/agent/dist/native-service.js"),
    agentVersion: "1.0.0",
  });
});
it("rejects escaped runtime symlink before executing it", async () => {
  const f = fixture();
  const node = join(f.bundle, "Contents/Helpers/node");
  rmSync(node);
  const target = join(f.root, "outside-node");
  writeFileSync(target, "fixture");
  symlinkSync(target, node);
  await expect(inspectBundleRuntime(f.bundle, { run: f.run })).rejects.toMatchObject({
    code: "unsafe-state",
  });
});
it.each(["legacy-only", "writable-directory", "symlink-directory"])(
  "rejects %s helper layout before executing Node",
  async (kind) => {
    const f = fixture();
    const helpers = join(f.bundle, "Contents/Helpers");
    if (kind === "legacy-only") {
      const legacy = join(f.bundle, "Contents/Resources/runtime/bin");
      mkdirSync(legacy);
      renameSync(join(helpers, "node"), join(legacy, "node"));
    } else if (kind === "writable-directory") {
      chmodSync(helpers, 0o777);
    } else {
      const redirected = join(f.root, "redirected-helpers");
      renameSync(helpers, redirected);
      symlinkSync(redirected, helpers);
    }
    const executedNodePaths: string[] = [];
    const run: ServiceCommand = async (exe, args, options) => {
      if (exe.endsWith("/node")) executedNodePaths.push(exe);
      return f.run(exe, args, options);
    };
    await expect(inspectBundleRuntime(f.bundle, { run })).rejects.toMatchObject({
      code: "unsafe-state",
    });
    expect(executedNodePaths).toEqual([]);
  },
);

it("rejects mismatched package version", async () => {
  const f = fixture();
  writeFileSync(
    join(f.bundle, "Contents/Resources/agent/package.json"),
    JSON.stringify({ name: "shellbell", version: "2.0.0", type: "module", dependencies: {} }),
  );
  await expect(inspectBundleRuntime(f.bundle, { run: f.run })).rejects.toMatchObject({
    code: "unsafe-state",
  });
});
it.each(["architecture", "script-version"])(
  "rejects wrong %s from bundled runtime",
  async (kind) => {
    const f = fixture();
    const run: ServiceCommand = async (exe, args, options) =>
      kind === "architecture" && args[0] === "-p"
        ? { exitCode: 0, stdout: Buffer.from("darwin:wrong\n") }
        : kind === "script-version" && args[0]?.endsWith("native-service.js")
          ? { exitCode: 0, stdout: Buffer.from("2.0.0\n") }
          : f.run(exe, args, options);
    await expect(inspectBundleRuntime(f.bundle, { run })).rejects.toMatchObject({
      code: "unsafe-state",
    });
  },
);
