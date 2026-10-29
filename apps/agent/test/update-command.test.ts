import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  downloadUpdate,
  installerReport,
  requireUpdateGlibc,
  requireUpdateMacOS,
  updateInstallation,
} from "../src/update-command.js";
import { ReleaseClient } from "../src/update-release.js";

const temporary: string[] = [];
async function directory() {
  const path = await realpath(await mkdtemp(join(tmpdir(), "shellbell-update-test-")));
  temporary.push(path);
  return path;
}
afterEach(async () => {
  await Promise.all(temporary.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe("manual update admission", () => {
  it("checks macOS versions numerically before downloading", () => {
    for (const value of ["13.0", "13.0.1", "14.0\n", "26.1"])
      expect(() => requireUpdateMacOS(value, "13.0")).not.toThrow();
    for (const value of ["12.7", "13.0"])
      expect(() => requireUpdateMacOS(value, "13.0.1")).toThrow("requires macOS");
    for (const value of ["", "13", "13.0\nextra", "9999.0"])
      expect(() => requireUpdateMacOS(value, "13.0")).toThrow("Could not verify");
  });
  it("recognizes the private Mac CLI only with the matching runtime and installer receipt", async () => {
    const home = await directory();
    const root = join(home, ".local/share/shellbell/installs/darwin-arm64/0.9.0");
    const cli = join(root, "Shellbell.app/Contents/Resources/agent/dist/cli.js");
    const node = join(root, "Shellbell.app/Contents/Helpers/node");
    await mkdir(join(cli, ".."), { recursive: true });
    await mkdir(join(node, ".."), { recursive: true });
    await writeFile(cli, "fixture");
    await writeFile(node, "fixture");
    const receipt = {
      schema: 1,
      platform: "darwin-arm64",
      version: "0.9.0",
      dmgSha256: "a".repeat(64),
    };
    await writeFile(join(root, "installation.json"), JSON.stringify(receipt), { mode: 0o600 });
    const options = { home, platform: "darwin", arch: "arm64", version: "0.9.0", cli, node };
    expect(await updateInstallation(options)).toBe("mac-cli");
    expect(await updateInstallation({ ...options, node: process.execPath })).toBe("mac-app");
    await writeFile(
      join(root, "installation.json"),
      JSON.stringify({ ...receipt, version: "0.8.0" }),
    );
    await expect(updateInstallation(options)).rejects.toThrow("Invalid managed");
  });
  it("honors the selected release's glibc floor before installation", () => {
    expect(() => requireUpdateGlibc("glibc 2.31\n", "2.35")).toThrow("requires glibc 2.35");
    expect(() => requireUpdateGlibc("glibc 2.35\n", "2.35")).not.toThrow();
    expect(() => requireUpdateGlibc("glibc 2.39\n", "2.35")).not.toThrow();
    expect(() => requireUpdateGlibc("glibc 3.0\n", "2.35")).not.toThrow();
    for (const output of ["musl 1.2.5", "", "glibc 2.35\nextra", "glibc 9999999.0"])
      expect(() => requireUpdateGlibc(output, "2.35")).toThrow("Could not verify");
  });
  it("admits only the canonical archive CLI and its matching bundled Node", async () => {
    const home = await directory();
    const root = join(home, ".local/share/shellbell/installs/linux-arm64/0.8.0");
    const cli = join(root, "agent/dist/cli.js");
    const node = join(root, "runtime/bin/node");
    await mkdir(join(root, "agent/dist"), { recursive: true });
    await mkdir(join(root, "runtime/bin"), { recursive: true });
    await writeFile(cli, "fixture");
    await writeFile(node, "fixture");
    const options = { home, platform: "linux", arch: "arm64", version: "0.8.0", cli, node };
    expect(await updateInstallation(options)).toBe("linux-archive");
    await symlink(root, join(root, "../current"));
    expect(
      await updateInstallation({ ...options, cli: join(root, "../current/agent/dist/cli.js") }),
    ).toBe("linux-archive");
    expect(await updateInstallation({ ...options, node: process.execPath })).toBe("other");
    expect(await updateInstallation({ ...options, version: "0.9.0" })).toBe("other");
    expect(await updateInstallation({ ...options, arch: "x64" })).toBe("other");
  });
  it("does not treat source/npm installs or a signed Mac bundle as writable Linux archives", async () => {
    const home = await directory();
    const cli = join(home, "cli.js");
    await writeFile(cli, "fixture");
    const options = {
      home,
      platform: "darwin",
      arch: "arm64",
      version: "0.8.0",
      cli,
      node: process.execPath,
    };
    expect(await updateInstallation(options)).toBe("other");
    const appCLI = join(home, "Shellbell.app/Contents/Resources/agent/dist/cli.js");
    await mkdir(join(appCLI, ".."), { recursive: true });
    await writeFile(appCLI, "fixture");
    expect(await updateInstallation({ ...options, cli: appCLI })).toBe("mac-app");
  });
});

describe("Linux installer report", () => {
  it("shows the staging folder the installer leaves in HOME", () => {
    expect(
      installerReport({
        stdout: "Installed Shellbell 0.9.0\n",
        stderr: "noise\nShellbell staging directory: /home/a/.shellbell-install.AbCd1234\n",
      }),
    ).toBe(
      "Installed Shellbell 0.9.0\nShellbell staging directory: /home/a/.shellbell-install.AbCd1234",
    );
    expect(installerReport({ stdout: "", stderr: "" })).toBe("");
  });
});

describe("explicit artifact download", () => {
  const bytes = Buffer.from("archive contents in multiple chunks");
  const asset = {
    name: "archive.tar.gz",
    size: bytes.length,
    digest: `sha256:${createHash("sha256").update(bytes).digest("hex")}`,
    browser_download_url:
      "https://github.com/bilal-/shellbell/releases/download/shellbell%400.9.0/archive.tar.gz",
  };
  function client(body: Uint8Array) {
    return new ReleaseClient(
      vi.fn(
        async () =>
          new Response(
            new ReadableStream({
              start(controller) {
                controller.enqueue(body.subarray(0, 10));
                controller.enqueue(body.subarray(10));
                controller.close();
              },
            }),
          ),
      ) as unknown as typeof fetch,
    );
  }
  it("streams and verifies every byte, and refuses to overwrite an existing file", async () => {
    const path = join(await directory(), "archive");
    await downloadUpdate(client(bytes), asset, path);
    expect(await readFile(path)).toEqual(bytes);
    await expect(downloadUpdate(client(bytes), asset, path)).rejects.toThrow();
    expect(await readFile(path)).toEqual(bytes);
  });
  it.each(["truncated", "oversized", "corrupt"])("refuses a %s archive", async (kind) => {
    const body =
      kind === "truncated"
        ? bytes.subarray(0, 12)
        : kind === "oversized"
          ? Buffer.concat([bytes, bytes])
          : Buffer.alloc(bytes.length);
    await expect(
      downloadUpdate(client(body), asset, join(await directory(), "archive")),
    ).rejects.toThrow(/size|digest/);
  });
});
