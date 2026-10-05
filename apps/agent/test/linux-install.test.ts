import { execFileSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

const roots: string[] = [];
function root() {
  const p = mkdtempSync(join(tmpdir(), "sb-linux-install-"));
  roots.push(p);
  return p;
}
function put(path: string, value: string, mode = 0o644) {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  writeFileSync(path, value, { mode });
}
async function api() {
  return import(pathToFileURL(resolve("../linux/scripts/install-lib.mjs")).href);
}
async function payload(version = "0.0.1", arch = process.arch) {
  const p = root();
  put(
    join(p, "runtime/bin/node"),
    `#!/bin/sh\ncase "$2" in --help) echo 'Usage: shellbell [options]' ;; *) echo '${version}' ;; esac\n`,
    0o755,
  );
  put(join(p, "runtime/LICENSE"), "Node license");
  put(
    join(p, "agent/package.json"),
    JSON.stringify({ name: "shellbell", type: "module", version }),
  );
  put(join(p, "agent/dist/cli.js"), "fixture");
  put(join(p, "install.mjs"), "fixture");
  put(join(p, "licenses/Shellbell-LICENSE"), "MIT");
  const { writeInventory } = await import(
    pathToFileURL(resolve("../linux/scripts/payload.mjs")).href
  );
  await writeInventory(p, {
    version,
    arch,
    sourceCommit: "a".repeat(40),
    runtimeVersion: "22.23.1",
    runtimeArchiveSha256:
      arch === "arm64"
        ? "0294e8b915ab75f92c7513d2fcb830ae06e10684e6c603e99a87dbf8835389c1"
        : "9749e988f437343b7fa832c69ded82a312e41a03116d766797ac14f6f9eee578",
  });
  return p;
}
function base(home: string, arch = process.arch) {
  return join(home, ".local/share/shellbell/installs", `linux-${arch}`);
}
function launch(home: string) {
  return execFileSync(join(home, ".local/bin/shellbell"), ["--version"], {
    env: { PATH: "/usr/bin:/bin", HOME: home },
    encoding: "utf8",
  }).trim();
}
afterEach(() => {
  for (const p of roots.splice(0)) rmSync(p, { recursive: true, force: true });
});

describe("per-user Linux archive installation", () => {
  it("preserves inventoried permissions under a private process umask", async () => {
    const { installPayload } = await api();
    const input = await payload();
    const home = root();
    const previous = process.umask(0o077);
    try {
      await installPayload({ payload: input, home });
      expect(launch(home)).toBe("0.0.1");
    } finally {
      process.umask(previous);
    }
  });

  it("refuses a replaceable HOME beneath a non-sticky writable ancestor", async () => {
    const { installPayload } = await api();
    const parent = root();
    const home = join(parent, "home");
    mkdirSync(home, { mode: 0o700 });
    chmodSync(parent, 0o777);
    await expect(installPayload({ payload: await payload(), home })).rejects.toThrow(
      "unsafe-home-ancestor",
    );
    expect(existsSync(join(home, ".local/bin/shellbell"))).toBe(false);
  });
  it("installs a working launcher with spaces in HOME without touching state", async () => {
    const { installPayload } = await api();
    const home = join(root(), "home with spaces");
    mkdirSync(home, { mode: 0o700 });
    put(join(home, ".local/state/shellbell/sentinel"), "identity stays");
    await installPayload({ payload: await payload(), home });
    expect(launch(home)).toBe("0.0.1");
    expect(readFileSync(join(home, ".local/state/shellbell/sentinel"), "utf8")).toBe(
      "identity stays",
    );
    expect(readlinkSync(join(base(home), "current"))).toBe("0.0.1");
  });

  it("repeats an identical installation and retains old bytes after upgrade", async () => {
    const { installPayload } = await api();
    const home = root();
    const first = await payload();
    await installPayload({ payload: first, home });
    const original = readFileSync(join(base(home), "0.0.1/runtime/bin/node"));
    await installPayload({ payload: first, home });
    await installPayload({ payload: await payload("0.0.2"), home });
    expect(launch(home)).toBe("0.0.2");
    expect(readFileSync(join(base(home), "0.0.1/runtime/bin/node"))).toEqual(original);
  });

  it("keeps independent architecture pointers in a shared home", async () => {
    const { installPayload } = await api();
    const home = root();
    await installPayload({ payload: await payload("0.0.1", "arm64"), home });
    await installPayload({ payload: await payload("0.0.2", "x64"), home });
    expect(readlinkSync(join(base(home, "arm64"), "current"))).toBe("0.0.1");
    expect(readlinkSync(join(base(home, "x64"), "current"))).toBe("0.0.2");
  });

  it.each(["symlink-parent", "writable-parent", "foreign-launcher", "symlink-launcher", "lock"])(
    "rejects unsafe installation target: %s",
    async (kind) => {
      const { installPayload } = await api();
      const home = root();
      const input = await payload();
      if (kind === "symlink-parent") symlinkSync(root(), join(home, ".local"));
      if (kind === "writable-parent") {
        mkdirSync(join(home, ".local"));
        chmodSync(join(home, ".local"), 0o777);
      }
      if (kind === "foreign-launcher") put(join(home, ".local/bin/shellbell"), "do not overwrite");
      if (kind === "symlink-launcher") {
        mkdirSync(join(home, ".local/bin"), { recursive: true });
        symlinkSync(input, join(home, ".local/bin/shellbell"));
      }
      if (kind === "lock")
        mkdirSync(join(home, ".local/share/shellbell/installs/.install.lock"), { recursive: true });
      await expect(installPayload({ payload: input, home })).rejects.toThrow();
      if (kind === "foreign-launcher")
        expect(readFileSync(join(home, ".local/bin/shellbell"), "utf8")).toBe("do not overwrite");
      expect(existsSync(join(base(home), "0.0.1"))).toBe(false);
    },
  );

  it("rejects changed bytes for an installed version while keeping its launcher usable", async () => {
    const { installPayload } = await api();
    const home = root();
    await installPayload({ payload: await payload(), home });
    const altered = await payload();
    writeFileSync(join(altered, "agent/dist/cli.js"), "different publisher payload");
    rmSync(join(altered, "inventory.json"));
    const { writeInventory } = await import(
      pathToFileURL(resolve("../linux/scripts/payload.mjs")).href
    );
    const old = JSON.parse(readFileSync(join(base(home), "0.0.1/inventory.json"), "utf8"));
    const { schema: _schema, files: _files, ...meta } = old;
    await writeInventory(altered, meta);
    await expect(installPayload({ payload: altered, home })).rejects.toThrow();
    expect(launch(home)).toBe("0.0.1");
  });

  it("rejects a hostile existing current pointer without changing it", async () => {
    const { installPayload } = await api();
    const home = root();
    await installPayload({ payload: await payload(), home });
    rmSync(join(base(home), "current"));
    symlinkSync("../../../../outside", join(base(home), "current"));
    await expect(installPayload({ payload: await payload("0.0.2"), home })).rejects.toThrow();
    expect(readlinkSync(join(base(home), "current"))).toBe("../../../../outside");
    expect(existsSync(join(base(home), "0.0.2"))).toBe(false);
  });

  it("rejects damaged input before publishing or switching a working installation", async () => {
    const { installPayload } = await api();
    const home = root();
    await installPayload({ payload: await payload(), home });
    const broken = await payload("0.0.2");
    writeFileSync(join(broken, "runtime/bin/node"), "corrupt");
    await expect(installPayload({ payload: broken, home })).rejects.toThrow();
    expect(launch(home)).toBe("0.0.1");
  });
});
