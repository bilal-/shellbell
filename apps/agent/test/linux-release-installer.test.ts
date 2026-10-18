import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
async function api() {
  return import(pathToFileURL(resolve("../linux/scripts/release-installer.mjs")).href);
}
const source = readFileSync(resolve("../linux/install.sh"), "utf8");

describe("Linux release installer", () => {
  it("names only the release version and changes nothing else", async () => {
    const { releaseInstaller } = await api();
    const stamped: string = releaseInstaller(source, "0.7.0");
    expect(stamped.match(/^release_version=.*$/gm)).toEqual(["release_version=0.7.0"]);
    expect(stamped.replace("release_version=0.7.0", "release_version=")).toBe(source);
  });

  it("refuses an invalid version or an installer without its version line", async () => {
    const { releaseInstaller } = await api();
    expect(() => releaseInstaller(source, "0.7")).toThrow(/invalid-version/);
    expect(() => releaseInstaller(source, "0.7.0;rm")).toThrow(/invalid-version/);
    const stamped = releaseInstaller(source, "0.7.0");
    expect(() => releaseInstaller(stamped, "0.7.1")).toThrow(/installer-version-line/);
  });

  it("writes the package version's installer with a matching checksum file", async () => {
    const { writeReleaseInstaller } = await api();
    const parent = mkdtempSync(join(tmpdir(), "sb-release-installer-"));
    roots.push(parent);
    const output = join(parent, "out");
    const result = writeReleaseInstaller({ output });
    const { version } = JSON.parse(readFileSync(resolve("package.json"), "utf8"));
    expect(result.version).toBe(version);
    expect(readFileSync(join(output, "install.sh"), "utf8")).toContain(
      `\nrelease_version=${version}\n`,
    );
    const line = readFileSync(join(output, "install.sh.sha256"), "utf8");
    expect(line).toBe(`${result.sha256}  install.sh\n`);
    const actual = execFileSync("shasum", ["-a", "256", join(output, "install.sh")], {
      encoding: "utf8",
    });
    expect(actual.split(" ")[0]).toBe(result.sha256);
    expect(() => writeReleaseInstaller({ output })).toThrow(/output-exists/);
  });
});
