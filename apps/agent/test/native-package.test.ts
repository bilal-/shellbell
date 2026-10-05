import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

const script = resolve("../macos/scripts/package-lib.mjs");
const roots: string[] = [];
function root() {
  const p = mkdtempSync(join(tmpdir(), "sb-package-test-"));
  roots.push(p);
  return p;
}
function put(p: string, value: string) {
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, value);
}
async function api() {
  return import(pathToFileURL(script).href);
}
afterEach(() => {
  for (const p of roots.splice(0)) rmSync(p, { recursive: true, force: true });
});

describe("native packaging admission", () => {
  it("preserves executable modes and internal links under a restrictive release umask", async () => {
    const { fileInventory } = await api();
    const source = root(),
      destination = join(root(), "copy");
    put(join(source, "bin/runtime"), "executable fixture");
    chmodSync(join(source, "bin/runtime"), 0o755);
    put(join(source, "NOTICE"), "license fixture");
    chmodSync(join(source, "NOTICE"), 0o644);
    symlinkSync("bin/runtime", join(source, "runtime"));
    const before = fileInventory(source);
    execFileSync(process.execPath, [
      "--input-type=module",
      "-e",
      "process.umask(0o077); const { copyTree } = await import(process.argv[1]); copyTree(process.argv[2], process.argv[3]);",
      pathToFileURL(script).href,
      source,
      destination,
    ]);
    expect(fileInventory(destination)).toEqual(before);
    expect(fileInventory(source)).toEqual(before);
  });

  it("removes deployment metadata without changing runtime files or licenses", async () => {
    const { pruneAgentBuildMetadata } = await api();
    const agent = root();
    put(join(agent, "node_modules/.modules.yaml"), "storeDir: /private/build-store\n");
    put(join(agent, "node_modules/.pnpm-workspace-state-v1.json"), "{}");
    put(join(agent, "node_modules/dependency/index.js"), "module.exports = 42;");
    put(join(agent, "node_modules/dependency/LICENSE"), "required license");
    pruneAgentBuildMetadata(agent);
    expect(() => readFileSync(join(agent, "node_modules/.modules.yaml"))).toThrow();
    expect(() => readFileSync(join(agent, "node_modules/.pnpm-workspace-state-v1.json"))).toThrow();
    expect(readFileSync(join(agent, "node_modules/dependency/index.js"), "utf8")).toBe(
      "module.exports = 42;",
    );
    expect(readFileSync(join(agent, "node_modules/dependency/LICENSE"), "utf8")).toBe(
      "required license",
    );
    expect(() => pruneAgentBuildMetadata(agent)).not.toThrow();
  });

  it("requires an explicit candidate number before building", async () => {
    const { parseBuildArgs, build } = await api();
    const args = [
      "--arch",
      "arm64",
      "--output",
      "/candidate",
      "--runtime-archive",
      "/runtime.tar.xz",
    ];
    expect(() => parseBuildArgs(args)).toThrow("positive integer build number");
    for (const number of ["0", "-1", "01", "1.0", "2beta", "2100000001"]) {
      expect(() => parseBuildArgs([...args, "--build-number", number])).toThrow();
    }
    expect(parseBuildArgs([...args, "--build-number", "42"]).buildNumber).toBe("42");
    await expect(
      build({ arch: "arm64", output: "/candidate", archive: "/runtime.tar.xz" }),
    ).rejects.toMatchObject({ code: "build-number" });
  });

  it("writes the computer version and reserved build number into the native bundle", async () => {
    const { setBundleVersion } = await api();
    const app = join(root(), "Shellbell.app");
    mkdirSync(join(app, "Contents"), { recursive: true });
    copyFileSync(resolve("../macos/Resources/Info.plist"), join(app, "Contents/Info.plist"));
    await setBundleVersion(app, "0.2.0", "42");
    const info = JSON.parse(
      execFileSync(
        "/usr/bin/plutil",
        ["-convert", "json", "-o", "-", join(app, "Contents/Info.plist")],
        { encoding: "utf8" },
      ),
    );
    expect(info.CFBundleShortVersionString).toBe("0.2.0");
    expect(info.CFBundleVersion).toBe("42");
    await expect(setBundleVersion(app, "0.2.0-beta.1", "43")).rejects.toThrow();
    expect(
      JSON.parse(
        execFileSync(
          "/usr/bin/plutil",
          ["-convert", "json", "-o", "-", join(app, "Contents/Info.plist")],
          { encoding: "utf8" },
        ),
      ),
    ).toEqual(info);
  });
  it.each(["exit", "timeout", "overflow"])(
    "retains bounded rejected subprocess evidence: %s",
    async (kind) => {
      const { run } = await api();
      const cwd = root(),
        logFile = join(cwd, "commands.jsonl");
      const body =
        kind === "exit"
          ? "process.stdout.write('stdout-evidence');process.stderr.write('stderr-evidence');process.exitCode=7"
          : kind === "timeout"
            ? "process.stdout.write('stdout-evidence');process.stderr.write('stderr-evidence');setInterval(()=>{},1000)"
            : "process.stderr.write('stderr-evidence');process.stdout.write('stdout-evidence'+'x'.repeat(1000000))";
      let failure: unknown;
      try {
        await run(process.execPath, ["-e", body], {
          cwd,
          logFile,
          timeout: kind === "timeout" ? 1000 : 5000,
          maxBuffer: 32768,
        });
      } catch (error) {
        failure = error;
      }
      expect(failure).toBeDefined();
      const bytes = readFileSync(logFile, "utf8"),
        entry = JSON.parse(bytes);
      expect(Buffer.byteLength(bytes)).toBeLessThan(100000);
      expect(entry.file).toBe(process.execPath);
      expect(entry.args).toEqual(["-e", body]);
      expect(entry.cwd).toBe(cwd);
      expect(entry.stdout).toContain("stdout-evidence");
      expect(entry.stderr).toContain("stderr-evidence");
      expect(entry.failure.code).toBe((failure as { code: unknown }).code);
      if (kind === "exit") expect(entry.failure.code).toBe(7);
      if (kind === "timeout") {
        expect(entry.failure.killed).toBe(true);
        expect(entry.failure.timeoutMs).toBe(1000);
      }
      if (kind === "overflow") expect(entry.failure.outputLimit).toBe(true);
      // A failed evidence write must preserve the subprocess rejection, too.
      await expect(
        run(process.execPath, ["-e", "process.exit(9)"], { logFile: cwd }),
      ).rejects.toMatchObject({ code: 9 });
    },
  );
  it("requires an exact version and intact bytes for supplemental dependency notices", async () => {
    const { loadSupplement } = await api();
    const source = root();
    const base = join(source, "apps/macos/Resources/DependencyLicenses");
    put(join(base, "dep-LICENSE"), "fixture notice");
    put(
      join(base, "index.json"),
      JSON.stringify({
        "dep@1.0.0": {
          license: "MIT",
          files: [
            {
              name: "dep-LICENSE",
              sha256: createHash("sha256").update("fixture notice").digest("hex"),
              source: "https://example.invalid/v1.0.0/LICENSE",
            },
          ],
        },
      }),
    );
    expect(loadSupplement(source, { name: "dep", version: "1.0.0", license: "MIT" })).toHaveLength(
      1,
    );
    expect(() =>
      loadSupplement(source, { name: "dep", version: "2.0.0", license: "MIT" }),
    ).toThrow();
    put(join(base, "dep-LICENSE"), "changed notice");
    expect(() =>
      loadSupplement(source, { name: "dep", version: "1.0.0", license: "MIT" }),
    ).toThrow();
  });
  it("rejects a corrupt runtime before invoking any archive command", async () => {
    const { verifyArchive } = await api();
    const p = join(root(), "runtime.tar.xz");
    put(p, "corrupt");
    let invoked = false;
    await expect(
      verifyArchive(p, "arm64", {
        run: () => {
          invoked = true;
          throw Error("must not run");
        },
      }),
    ).rejects.toMatchObject({ code: "runtime-integrity" });
    expect(invoked).toBe(false);
  });
  it("rejects symlink runtime input before any command", async () => {
    const { verifyArchive } = await api();
    const r = root();
    put(join(r, "file"), "archive");
    symlinkSync(join(r, "file"), join(r, "link"));
    await expect(verifyArchive(join(r, "link"), "arm64")).rejects.toMatchObject({
      code: "unsafe-file",
    });
  });
  it("refuses unsupported architecture, relative output, injection and existing targets", async () => {
    const { parseBuildArgs, requireNewPath } = await api();
    for (const args of [
      ["--arch", "arm64;touch /tmp/no"],
      ["--arch", "ppc"],
      ["--arch", "arm64", "--output", "relative", "--runtime-archive", "/a"],
    ]) {
      expect(() => parseBuildArgs(args)).toThrow();
    }
    expect(() => requireNewPath(root())).toThrow();
  });
  it("rejects escaping archive names and special runtime members", async () => {
    const { admitArchiveListing } = await api();
    for (const name of ["../escape", "/absolute", "node-v22.23.1-darwin-arm64/../../escape"]) {
      expect(() => admitArchiveListing(`${name}\n`, "-rw-r--r-- x", "arm64")).toThrow();
    }
    const names = "node-v22.23.1-darwin-arm64/bin/node\nnode-v22.23.1-darwin-arm64/LICENSE\n";
    for (const kind of ["l", "h", "p", "b", "c", "s"])
      expect(() =>
        admitArchiveListing(names, `${kind}rw-r--r-- x\n-rw-r--r-- x\n`, "arm64"),
      ).toThrow();
    expect(() => admitArchiveListing(names, "-rw-r--r-- x\n-rw-r--r-- x\n", "x64")).toThrow();
  });
  it("rejects dirty committed source and snapshots without touching source node_modules", async () => {
    const { snapshotSource } = await api();
    const source = root();
    const staging = root();
    const git = (...args: string[]) =>
      execFileSync("git", args, {
        cwd: source,
        env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" },
      });
    put(join(source, ".gitignore"), "node_modules/\n");
    put(join(source, "package.json"), "{}\n");
    git("init", "-q");
    git("add", ".");
    git(
      "-c",
      "user.name=Fixture",
      "-c",
      "user.email=fixture@example.invalid",
      "commit",
      "-qm",
      "fixture",
    );
    const metadata = join(source, "node_modules/.modules.yaml");
    put(metadata, "must remain unchanged\n");
    const result = await snapshotSource(source, staging);
    put(join(result.source, "node_modules/.modules.yaml"), "deployment mutation\n");
    expect(readFileSync(metadata, "utf8")).toBe("must remain unchanged\n");
    expect(readFileSync(join(result.source, "package.json"), "utf8")).toBe("{}\n");
    put(join(source, "package.json"), '{"dirty":true}\n');
    await expect(snapshotSource(source, root())).rejects.toMatchObject({ code: "dirty-source" });
  });
});

function bundle() {
  const app = join(root(), "Shellbell.app");
  const contents = join(app, "Contents");
  const resources = join(contents, "Resources");
  const files: Record<string, string> = {
    "Info.plist": "plist",
    "MacOS/Shellbell": "swift",
    "Library/HelperTools/ShellbellPowerHelper": "swift power",
    "Library/LaunchDaemons/sh.bilal.shellbell.power.plist": JSON.stringify({
      Label: "sh.bilal.shellbell.power",
      BundleProgram: "Contents/Library/HelperTools/ShellbellPowerHelper",
      ProgramArguments: ["ShellbellPowerHelper"],
      UserName: "root",
      MachServices: { "sh.bilal.shellbell.power": true },
      RunAtLoad: true,
      KeepAlive: true,
      ProcessType: "Background",
      ThrottleInterval: 10,
      ExitTimeOut: 20,
    }),
    "Library/LaunchAgents/sh.bilal.shellbell.host.agent.plist": "launch",
    "Resources/ShellbellService.icns": "icon",
    "Resources/ShellbellTemplate.png": "png",
    "Resources/ShellbellTemplate@2x.png": "png2",
    "Helpers/node": "node",
    "Resources/runtime/LICENSE": "node license",
    "Resources/agent/package.json": JSON.stringify({
      name: "shellbell",
      version: "0.0.1",
      type: "module",
      dependencies: { dep: "1.0.0" },
    }),
    "Resources/agent/dist/cli.js": 'import "./shared.js";\n',
    "Resources/agent/dist/native-controller.js": 'import "./shared.js";\n',
    "Resources/agent/dist/native-service.js": 'import "./shared.js";\n',
    "Resources/agent/dist/shared.js": 'import "dep";\n',
    "Resources/agent/node_modules/dep/package.json":
      '{"name":"dep","version":"1.0.0","main":"index.js","license":"MIT"}',
    "Resources/agent/node_modules/dep/index.js": "module.exports = {};",
    "Resources/agent/node_modules/dep/LICENSE": "dep license",
    "Resources/licenses/Shellbell-LICENSE": "shellbell license",
    "Resources/licenses/dep-LICENSE": "dep license",
    "Resources/licenses/index.json": JSON.stringify([
      { name: "dep", version: "1.0.0", files: ["dep-LICENSE"] },
    ]),
  };
  for (const [name, content] of Object.entries(files)) put(join(contents, name), content);
  chmodSync(join(contents, "MacOS/Shellbell"), 0o755);
  chmodSync(join(contents, "Library/HelperTools/ShellbellPowerHelper"), 0o755);
  chmodSync(join(contents, "Helpers/node"), 0o755);
  const run = async (file: string, args: string[]) => {
    if (file === "/usr/bin/plutil" && args.at(-1)?.endsWith("sh.bilal.shellbell.power.plist"))
      return readFileSync(args.at(-1)!, "utf8");
    if (file === "/usr/bin/plutil")
      return JSON.stringify(
        args.at(-1)?.endsWith("Info.plist")
          ? {
              CFBundleIdentifier: "sh.bilal.shellbell.host",
              CFBundleExecutable: "Shellbell",
              CFBundlePackageType: "APPL",
              CFBundleShortVersionString: "0.0.1",
              CFBundleVersion: "1",
              CFBundleIconFile: "ShellbellService",
              LSMinimumSystemVersion: "13.0",
              LSUIElement: true,
            }
          : {
              Label: "sh.bilal.shellbell.host.agent",
              BundleProgram: "Contents/MacOS/Shellbell",
              ProgramArguments: ["Shellbell", "--service-run", "persistent"],
              RunAtLoad: true,
              KeepAlive: true,
              ProcessType: "Background",
              ThrottleInterval: 10,
            },
      );
    if (file === "/usr/bin/lipo") return "arm64\n";
    if (file.endsWith("/Helpers/node") && args.length === 1 && args[0] === "--version")
      return "v22.23.1";
    throw Error(`unexpected execution ${file}`);
  };
  return { app, resources, run };
}

describe("bundle closure admission before executable smoke", () => {
  it("rejects deployment metadata before executing a bundled runtime", async () => {
    const { inspectBundle } = await api();
    const f = bundle();
    put(join(f.resources, "agent/node_modules/.modules.yaml"), "storeDir: /private/build-store\n");
    let runtimeCalls = 0;
    const run = async (file: string, args: string[]) => {
      if (file.endsWith("/Helpers/node")) runtimeCalls++;
      return f.run(file, args);
    };
    await expect(inspectBundle(f.app, { run })).rejects.toMatchObject({
      code: "build-tool-metadata",
    });
    expect(runtimeCalls).toBe(0);
  });

  it("rejects candidate-number drift before executing the runtime", async () => {
    const { writeInventory, verifyBundle } = await api();
    const f = bundle();
    await writeInventory(f.app, {
      arch: "arm64",
      buildNumber: "2",
      sourceCommit: "a".repeat(40),
      runtimeArchiveSha256: "fb526811860f81dcac7dd8b2b55eca4accfc5d61c3b7c2508f2639faee8a738d",
    });
    let runtimeCalls = 0;
    const run = async (file: string, args: string[]) => {
      if (file.endsWith("/Helpers/node")) runtimeCalls++;
      return f.run(file, args);
    };
    await expect(verifyBundle(f.app, { run })).rejects.toMatchObject({ code: "bundle-integrity" });
    expect(runtimeCalls).toBe(0);
  });
  it("rejects changed helper bytes before executing Node", async () => {
    const { writeInventory, verifyBundle } = await api();
    const f = bundle();
    await writeInventory(f.app, {
      arch: "arm64",
      buildNumber: "1",
      sourceCommit: "a".repeat(40),
      runtimeArchiveSha256: "fb526811860f81dcac7dd8b2b55eca4accfc5d61c3b7c2508f2639faee8a738d",
    });
    writeFileSync(join(f.app, "Contents/Helpers/node"), "altered helper");
    const executedNodePaths: string[] = [];
    const run = async (file: string, args: string[]) => {
      if (file.endsWith("/node")) executedNodePaths.push(file);
      return f.run(file, args);
    };
    await expect(verifyBundle(f.app, { run })).rejects.toMatchObject({
      code: "bundle-integrity",
    });
    expect(executedNodePaths).toEqual([]);
  });

  it("rejects a legacy Resources-only runtime rather than falling back", async () => {
    const { verifyBundle } = await api();
    const f = bundle();
    const helper = join(f.app, "Contents/Helpers/node");
    put(join(f.resources, "runtime/bin/node"), readFileSync(helper, "utf8"));
    chmodSync(join(f.resources, "runtime/bin/node"), 0o755);
    rmSync(helper);
    const executedNodePaths: string[] = [];
    const run = async (file: string, args: string[]) => {
      if (file.endsWith("/node")) {
        executedNodePaths.push(file);
        return "v22.23.1";
      }
      return f.run(file, args);
    };
    await expect(verifyBundle(f.app, { run, inventory: false })).rejects.toThrow();
    expect(executedNodePaths).toEqual([]);
  });

  it("allows createRequire only for resolver-only metadata inspection", async () => {
    const { verifyBundle } = await api();
    const f = bundle();
    put(
      join(f.resources, "agent/dist/shared.js"),
      'import { createRequire as make } from "node:module"; const inspect = make(import.meta.url); inspect.resolve(process.env.NAME);',
    );
    await expect(verifyBundle(f.app, { run: f.run, inventory: false })).resolves.toMatchObject({
      arch: "arm64",
    });
    put(
      join(f.resources, "agent/dist/shared.js"),
      'import { createRequire as make } from "node:module"; const load = make(import.meta.url); load("missing");',
    );
    await expect(verifyBundle(f.app, { run: f.run, inventory: false })).rejects.toThrow();
  });
  it("distinguishes minified createRequire bindings from unrelated lexical names", async () => {
    const { verifyBundle } = await api();
    const f = bundle();
    put(
      join(f.resources, "agent/dist/shared.js"),
      `
      import { createRequire as x } from "node:module";
      function inspect() { const r = x(import.meta.url); return r.resolve(process.env.NAME); }
      function unrelated(x) { const r = x; return { x, r }; }
      function nested() { const r = x(import.meta.url); function other(r) { return r; } return r.resolve("node:fs"); }
      export { inspect, unrelated, nested };
    `,
    );
    await expect(verifyBundle(f.app, { run: f.run, inventory: false })).resolves.toMatchObject({
      arch: "arm64",
    });
  });

  it.each([
    'const alias = x; alias(import.meta.url)("missing");',
    "export { x as make };",
    "const alias = { x };",
    'const r = x(import.meta.url); function nested() { return r("missing"); }',
    'const r = x(import.meta.url); const alias = r; alias.resolve("missing");',
    "const r = x(import.meta.url); const alias = { r };",
  ])("rejects actual loader aliases and nested callable uses: %s", async (source) => {
    const { verifyBundle } = await api();
    const f = bundle();
    put(
      join(f.resources, "agent/dist/shared.js"),
      `import { createRequire as x } from "node:module"; ${source}`,
    );
    await expect(verifyBundle(f.app, { run: f.run, inventory: false })).rejects.toThrow();
  });
  it("keeps relative generated chunks confined to dist", async () => {
    const { verifyBundle } = await api();
    const f = bundle();
    put(join(f.resources, "agent/dist/shared.js"), 'import "../node_modules/dep/index.js";');
    await expect(verifyBundle(f.app, { run: f.run, inventory: false })).rejects.toThrow();
  });
  it("rejects an aliased require whose closure cannot be resolved statically", async () => {
    const { verifyBundle } = await api();
    const f = bundle();
    put(
      join(f.resources, "agent/node_modules/dep/index.js"),
      'const load = require; load("missing");',
    );
    await expect(verifyBundle(f.app, { run: f.run, inventory: false })).rejects.toThrow();
  });
  it("allows only wholly absent, declared optional packages behind a catch fallback", async () => {
    const { verifyBundle } = await api();
    const f = bundle();
    put(
      join(f.resources, "agent/node_modules/dep/package.json"),
      JSON.stringify({
        name: "dep",
        version: "1.0.0",
        main: "index.js",
        peerDependencies: { accelerator: "^1.0.0" },
        peerDependenciesMeta: { accelerator: { optional: true } },
      }),
    );
    put(
      join(f.resources, "agent/node_modules/dep/index.js"),
      'try { require("accelerator"); } catch {}',
    );
    await expect(verifyBundle(f.app, { run: f.run, inventory: false })).resolves.toMatchObject({
      arch: "arm64",
    });
    put(
      join(f.resources, "agent/node_modules/dep/index.js"),
      'try { require("accelerator"); } catch (error) { throw error; }',
    );
    await expect(verifyBundle(f.app, { run: f.run, inventory: false })).rejects.toThrow();
    put(
      join(f.resources, "agent/node_modules/dep/index.js"),
      'try { require("accelerator"); } catch {}',
    );
    put(
      join(f.resources, "agent/node_modules/accelerator/package.json"),
      '{"name":"accelerator","version":"1.0.0","main":"missing.cjs"}',
    );
    await expect(verifyBundle(f.app, { run: f.run, inventory: false })).rejects.toThrow();
    put(
      join(f.resources, "agent/node_modules/accelerator/missing.cjs"),
      'require("missing-transitive");',
    );
    await expect(verifyBundle(f.app, { run: f.run, inventory: false })).rejects.toThrow();
  });
  it("rejects a self-consistent inventory around the wrong actual runtime version", async () => {
    const { verifyBundle, writeInventory, makeDmg } = await api();
    const f = bundle();
    await writeInventory(f.app, {
      arch: "arm64",
      buildNumber: "1",
      sourceCommit: "a".repeat(40),
      runtimeArchiveSha256: "fb526811860f81dcac7dd8b2b55eca4accfc5d61c3b7c2508f2639faee8a738d",
    });
    const command = async (file: string, args: string[]) =>
      file.endsWith("/Helpers/node") ? "v20.0.0" : f.run(file, args);
    await expect(verifyBundle(f.app, { run: command })).rejects.toMatchObject({
      code: "runtime-version",
    });
    await expect(makeDmg(f.app, join(root(), "new.dmg"), { run: command })).rejects.toMatchObject({
      code: "runtime-version",
    });
  });
  it("fails closed when the host cannot execute the verified runtime architecture", async () => {
    const { verifyBundle, writeInventory } = await api();
    const f = bundle();
    await writeInventory(f.app, {
      arch: "arm64",
      buildNumber: "1",
      sourceCommit: "a".repeat(40),
      runtimeArchiveSha256: "fb526811860f81dcac7dd8b2b55eca4accfc5d61c3b7c2508f2639faee8a738d",
    });
    const command = async (file: string, args: string[]) => {
      if (file.endsWith("/Helpers/node"))
        throw Object.assign(Error("unsupported binary"), { code: "ENOEXEC" });
      return f.run(file, args);
    };
    await expect(verifyBundle(f.app, { run: command })).rejects.toMatchObject({
      code: "runtime-version-unavailable",
    });
  });
  it("follows ESM exports and static transitive imports without evaluating either module", async () => {
    const { verifyBundle } = await api();
    const f = bundle();
    put(
      join(f.resources, "agent/node_modules/dep/package.json"),
      JSON.stringify({
        name: "dep",
        version: "1.0.0",
        exports: { import: "./esm.mjs", require: "./absent.cjs" },
      }),
    );
    put(
      join(f.resources, "agent/node_modules/dep/esm.mjs"),
      'import "./child.mjs"; throw Error("must not evaluate");',
    );
    put(join(f.resources, "agent/node_modules/dep/child.mjs"), 'throw Error("must not evaluate");');
    await expect(verifyBundle(f.app, { run: f.run, inventory: false })).resolves.toMatchObject({
      arch: "arm64",
    });
  });
  it("admits legacy sloppy CommonJS strings while still validating their requires", async () => {
    const { verifyBundle } = await api();
    const f = bundle();
    put(
      join(f.resources, "agent/node_modules/dep/index.js"),
      'const color = "\\033[40m"; require("./child.cjs");',
    );
    put(join(f.resources, "agent/node_modules/dep/child.cjs"), 'throw Error("must not evaluate");');
    await expect(verifyBundle(f.app, { run: f.run, inventory: false })).resolves.toMatchObject({
      arch: "arm64",
    });
    rmSync(join(f.resources, "agent/node_modules/dep/child.cjs"));
    await expect(verifyBundle(f.app, { run: f.run, inventory: false })).rejects.toThrow();
  });
  it("rejects an absent ESM export even when the CommonJS branch exists", async () => {
    const { verifyBundle } = await api();
    const f = bundle();
    put(
      join(f.resources, "agent/node_modules/dep/package.json"),
      JSON.stringify({
        name: "dep",
        version: "1.0.0",
        exports: { import: "./missing.mjs", require: "./index.js" },
      }),
    );
    await expect(verifyBundle(f.app, { run: f.run, inventory: false })).rejects.toThrow();
  });
  it.each(["./missing.mjs", "missing-transitive"])(
    "rejects missing dependency import %s",
    async (specifier) => {
      const { verifyBundle } = await api();
      const f = bundle();
      put(
        join(f.resources, "agent/node_modules/dep/index.js"),
        `require(${JSON.stringify(specifier)});`,
      );
      await expect(verifyBundle(f.app, { run: f.run, inventory: false })).rejects.toThrow();
    },
  );
  it("rejects unresolved dynamic dependency forms rather than evaluating code", async () => {
    const { verifyBundle } = await api();
    const f = bundle();
    put(join(f.resources, "agent/node_modules/dep/index.js"), "require(process.env.DEPENDENCY);");
    await expect(verifyBundle(f.app, { run: f.run, inventory: false })).rejects.toThrow();
  });
  it("keeps internal dependency links within a relocated bundle", async () => {
    const { copyTree, verifyBundle } = await api();
    const f = bundle();
    symlinkSync("index.js", join(f.resources, "agent/node_modules/dep/alias.js"));
    const copied = join(root(), "Shellbell.app");
    copyTree(f.app, copied);
    await expect(verifyBundle(copied, { run: f.run, inventory: false })).resolves.toMatchObject({
      arch: "arm64",
    });
  });
  it("admits generated shared chunks and rejects their absence or escape", async () => {
    const { verifyBundle } = await api();
    const f = bundle();
    await expect(verifyBundle(f.app, { run: f.run, inventory: false })).resolves.toMatchObject({
      arch: "arm64",
      version: "0.0.1",
    });
    const shared = join(f.resources, "agent/dist/shared.js");
    rmSync(shared);
    await expect(verifyBundle(f.app, { run: f.run, inventory: false })).rejects.toThrow();
    const external = join(root(), "outside.js");
    put(external, "export {};");
    symlinkSync(external, shared);
    await expect(verifyBundle(f.app, { run: f.run, inventory: false })).rejects.toThrow();
  });
  it.each([
    "runtime/LICENSE",
    "ShellbellTemplate@2x.png",
    "licenses/dep-LICENSE",
    "agent/node_modules/dep/index.js",
  ])("rejects missing required %s", async (name) => {
    const { verifyBundle } = await api();
    const f = bundle();
    rmSync(join(f.resources, name));
    await expect(verifyBundle(f.app, { run: f.run, inventory: false })).rejects.toThrow();
  });
  it("rejects wrong architecture and wrong app version without executing bundled Node", async () => {
    const { verifyBundle } = await api();
    const f = bundle();
    await expect(
      verifyBundle(f.app, { run: f.run, arch: "x64", inventory: false }),
    ).rejects.toThrow();
    const p = join(f.resources, "agent/package.json");
    put(p, readFileSync(p, "utf8").replace("0.0.1", "9.9.9"));
    await expect(verifyBundle(f.app, { run: f.run, inventory: false })).rejects.toThrow();
  });
  it("refuses invalid bundles before bundled Node smoke and preserves existing DMG output", async () => {
    const { smokeBundle, makeDmg } = await api();
    const f = bundle();
    const output = join(root(), "existing.dmg");
    put(output, "preserve me");
    let executed = false;
    await expect(
      smokeBundle(f.app, async (file: string, args: string[]) => {
        if (file.endsWith("/node")) executed = true;
        return f.run(file, args);
      }),
    ).rejects.toThrow();
    expect(executed).toBe(false);
    await expect(makeDmg(f.app, output)).rejects.toMatchObject({ code: "output-exists" });
    expect(readFileSync(output, "utf8")).toBe("preserve me");
  });
  it("rejects changed inventory bytes", async () => {
    const { writeInventory, verifyBundle } = await api();
    const f = bundle();
    await writeInventory(f.app, {
      arch: "arm64",
      buildNumber: "1",
      sourceCommit: "a".repeat(40),
      runtimeArchiveSha256: "fb526811860f81dcac7dd8b2b55eca4accfc5d61c3b7c2508f2639faee8a738d",
    });
    put(join(f.resources, "agent/dist/shared.js"), "tampered\n");
    await expect(verifyBundle(f.app, { run: f.run })).rejects.toThrow();
  });
});
