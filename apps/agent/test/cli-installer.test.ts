import { execFileSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

const temporary: string[] = [];
function directory() {
  const path = mkdtempSync(join(tmpdir(), "shellbell-cli-installer-"));
  temporary.push(path);
  return path;
}
async function api(name: string) {
  return import(pathToFileURL(resolve(`../installer/${name}.mjs`)).href);
}
afterEach(() => {
  for (const path of temporary.splice(0)) rmSync(path, { recursive: true, force: true });
});
const release = {
  sourceCommit: "a".repeat(40),
  schemaVersion: 1,
  component: "computer",
  channel: "stable",
  version: "0.9.0",
  tag: "shellbell@0.9.0",
  platforms: {
    macosArm64: {
      asset: "Shellbell-0.9.0-arm64.dmg",
      sha256: "a".repeat(64),
      minimumOS: "13.0",
      signed: true,
      notarized: true,
    },
    linuxArm64: { asset: "shellbell-0.9.0-linux-arm64.tar.gz", sha256: "b".repeat(64) },
    linuxX64: { asset: "shellbell-0.9.0-linux-x64.tar.gz", sha256: "c".repeat(64) },
  },
};
describe("unified CLI release installer", () => {
  it("writes installer metadata separately without changing the strict computer manifest", async () => {
    const { writeInstaller } = await api("release-installer");
    const parent = directory();
    const manifest = join(parent, "computer-release.json");
    const original = JSON.stringify(release);
    writeFileSync(manifest, original);
    const result = writeInstaller({ manifest, output: join(parent, "output") });
    expect(result).toMatchObject({
      component: "cli-installer",
      sourceCommit: release.sourceCommit,
      tag: release.tag,
      installer: { asset: "install-cli.sh" },
    });
    expect(JSON.parse(readFileSync(join(parent, "output/cli-installer.json"), "utf8"))).toEqual(
      result,
    );
    expect(readFileSync(manifest, "utf8")).toBe(original);
  });
  it("emits a valid POSIX script and offers help without installation or network", async () => {
    const { createInstaller } = await api("release-installer");
    const home = directory();
    const script = join(directory(), "install.sh");
    writeFileSync(script, createInstaller(release));
    execFileSync("/bin/sh", ["-n", script]);
    const output = execFileSync("/bin/sh", [script, "--help"], {
      encoding: "utf8",
      env: { PATH: "/usr/bin:/bin", HOME: home },
    });
    expect(output).toContain("Apple silicon macOS 13.0+");
    expect(output).toContain("Linux ARM64/x64");
    expect(existsSync(join(home, ".local"))).toBe(false);
  });
  it("refuses incomplete qualification and shell injection in release metadata", async () => {
    const { createInstaller } = await api("release-installer");
    for (const changed of [
      { ...release, version: "0.9.0; touch bad" },
      { ...release, channel: "preview" },
      {
        ...release,
        platforms: {
          ...release.platforms,
          macosArm64: { ...release.platforms.macosArm64, notarized: false },
        },
      },
      {
        ...release,
        platforms: {
          ...release.platforms,
          macosArm64: { ...release.platforms.macosArm64, minimumOS: "13.0'; false" },
        },
      },
      { ...release, platforms: { ...release.platforms, linuxArm64: undefined } },
    ])
      expect(() => createInstaller(changed)).toThrow();
  });
  it("pins Mac bytes and reuses the existing versioned Linux bootstrap", async () => {
    const { createInstaller } = await api("release-installer");
    const script = createInstaller(release);
    const source = readFileSync(resolve("../linux/install.sh"), "utf8");
    expect(script).toContain(source.replace("\nrelease_version=\n", "\nrelease_version=0.9.0\n"));
    expect(script).toContain(`--sha256 '${release.platforms.macosArm64.sha256}'`);
    expect(script).not.toContain("releases/latest");
  });
});
describe("Mac CLI installation ownership", () => {
  it("preserves confined dependency links and refuses escaping, broken and cyclic links", async () => {
    const { inspectTree } = await api("macos-install");
    const app = directory();
    mkdirSync(join(app, "bin"));
    mkdirSync(join(app, "package"));
    writeFileSync(join(app, "package/cli.js"), "signed dependency");
    symlinkSync("../package/cli.js", join(app, "bin/cli"));
    expect(() => inspectTree(app)).not.toThrow();
    for (const target of [join(app, "package/cli.js"), "../../escape", "missing", "bad"]) {
      symlinkSync(target, join(app, "bad"));
      expect(() => inspectTree(app)).toThrow();
      rmSync(join(app, "bad"));
    }
  });
  it("preserves identities and refuses foreign launchers", async () => {
    const { prepare } = await api("macos-install");
    const home = directory();
    mkdirSync(join(home, ".shellbell"));
    writeFileSync(join(home, ".shellbell/identity.json"), "private sentinel");
    const state = prepare(home);
    writeFileSync(state.launcher, "user-owned executable");
    expect(() => prepare(home)).toThrow("existing launcher");
    expect(readFileSync(state.launcher, "utf8")).toBe("user-owned executable");
    expect(readFileSync(join(home, ".shellbell/identity.json"), "utf8")).toBe("private sentinel");
  });
  it("refuses symlinked destinations and writable HOME ancestors", async () => {
    const { prepare } = await api("macos-install");
    const home = directory();
    symlinkSync(directory(), join(home, ".local"));
    expect(() => prepare(home)).toThrow("unsafe installation directory");
    const parent = directory();
    const nested = join(parent, "home");
    mkdirSync(nested, { mode: 0o700 });
    chmodSync(parent, 0o777);
    expect(() => prepare(nested)).toThrow("unsafe HOME ancestor");
  });
});
