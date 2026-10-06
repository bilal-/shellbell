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
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

const roots: string[] = [];
const metadata = {
  version: "0.0.1",
  arch: "arm64",
  sourceCommit: "a".repeat(40),
  runtimeVersion: "22.23.1",
  runtimeArchiveSha256: "0294e8b915ab75f92c7513d2fcb830ae06e10684e6c603e99a87dbf8835389c1",
};
function put(root: string, name: string, value: string, mode = 0o644) {
  const target = join(root, name);
  mkdirSync(dirname(target), { recursive: true, mode: 0o755 });
  writeFileSync(target, value, { mode });
}
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "sb-linux-payload-"));
  roots.push(root);
  put(root, "runtime/bin/node", "fixture executable, never run", 0o755);
  put(root, "runtime/LICENSE", "Node license");
  put(
    root,
    "agent/package.json",
    JSON.stringify({ name: "shellbell", version: "0.0.1", type: "module" }),
  );
  put(root, "agent/dist/cli.js", "throw Error('never execute during admission');");
  put(root, "licenses/Shellbell-LICENSE", "MIT");
  put(root, "install.mjs", "throw Error('never execute during admission');");
  return root;
}
async function api() {
  return import(pathToFileURL(resolve("../linux/scripts/payload.mjs")).href);
}
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("Linux payload admission", () => {
  it.each(["cborg", "@noble/ciphers", "@noble/curves", "@noble/hashes"])(
    "includes the complete upstream license for bundled %s",
    async (name) => {
      const { collectLicenses } = await import(
        pathToFileURL(resolve("../linux/scripts/build-lib.mjs")).href
      );
      const root = fixture();
      mkdirSync(join(root, "agent/node_modules"));
      const output = join(root, "collected");
      const notices = collectLicenses(join(root, "agent"), output, resolve("../../LICENSE"));
      const upstream = resolve("../../node_modules", name);
      const pkg = JSON.parse(readFileSync(join(upstream, "package.json"), "utf8"));
      const notice = notices.find((item: { name: string }) => item.name === name);
      expect(notice).toMatchObject({ name, version: pkg.version });
      expect(notice.files).toHaveLength(1);
      expect(readFileSync(join(output, notice.files[0]))).toEqual(
        readFileSync(join(upstream, "LICENSE")),
      );
    },
  );

  it.each(["arm64", "x64"])(
    "includes the pinned license for the Linux %s WebRTC binary",
    async (arch) => {
      const { collectLicenses } = await import(
        pathToFileURL(resolve("../linux/scripts/build-lib.mjs")).href
      );
      const root = fixture();
      const name = `@node-datachannel/linux-${arch}-gnu`;
      put(
        root,
        `agent/node_modules/${name}/package.json`,
        JSON.stringify({
          name,
          version: "0.33.4",
          license: "MPL 2.0",
        }),
      );
      const output = join(root, "collected");
      const notices = collectLicenses(join(root, "agent"), output, resolve("../../LICENSE"));
      expect(notices[0].files).toHaveLength(1);
      expect(readFileSync(join(output, notices[0].files[0]), "utf8")).toContain(
        "Mozilla Public License",
      );
      expect(notices[0].sources).toHaveLength(1);
    },
  );
  it("includes the pinned upstream license supplement omitted by protobuf npm packages", async () => {
    const { collectLicenses } = await import(
      pathToFileURL(resolve("../linux/scripts/build-lib.mjs")).href
    );
    const root = fixture();
    put(
      root,
      "agent/node_modules/@bufbuild/protobuf/package.json",
      JSON.stringify({
        name: "@bufbuild/protobuf",
        version: "2.14.1",
        license: "(Apache-2.0 AND BSD-3-Clause)",
      }),
    );
    const output = join(root, "collected");
    const notices = collectLicenses(join(root, "agent"), output, resolve("../../LICENSE"));
    expect(notices[0].files).toHaveLength(2);
    const text = notices[0].files
      .map((f: string) => readFileSync(join(output, f), "utf8"))
      .join("\n");
    expect(text).toContain("Apache License");
    expect(text).toContain("Redistribution");
    expect(notices[0].sources).toHaveLength(2);
  });
  it("rejects an altered runtime archive without extracting it", async () => {
    const { verifyRuntimeArchive } = await import(
      pathToFileURL(resolve("../linux/scripts/build-lib.mjs")).href
    );
    const root = fixture();
    const archive = join(root, "runtime.tar.xz");
    writeFileSync(archive, "not the pinned official archive");
    await expect(verifyRuntimeArchive(archive, "arm64")).rejects.toThrow(/runtime/);
    expect(existsSync(join(root, "node-v22.23.1-linux-arm64"))).toBe(false);
  });

  it("flattens contained dependency links but refuses escapes", async () => {
    const { copyPayloadTree } = await import(
      pathToFileURL(resolve("../linux/scripts/build-lib.mjs")).href
    );
    const root = fixture();
    put(root, "dependencies/pkg/index.js", "export default 1;");
    symlinkSync("pkg", join(root, "dependencies/alias"));
    copyPayloadTree(
      join(root, "dependencies/alias"),
      join(root, "copied"),
      join(root, "dependencies"),
    );
    expect(readFileSync(join(root, "copied/index.js"), "utf8")).toBe("export default 1;");
    symlinkSync("../agent", join(root, "dependencies/escape"));
    expect(() =>
      copyPayloadTree(
        join(root, "dependencies/escape"),
        join(root, "escaped"),
        join(root, "dependencies"),
      ),
    ).toThrow();
    expect(existsSync(join(root, "escaped"))).toBe(false);
  });

  it("rejects a runtime binary for the wrong CPU before running it", async () => {
    const { verifyElf } = await import(
      pathToFileURL(resolve("../linux/scripts/build-lib.mjs")).href
    );
    const root = fixture();
    const binary = join(root, "runtime/bin/node");
    const bytes = Buffer.alloc(64);
    bytes.set([0x7f, 0x45, 0x4c, 0x46, 2, 1]);
    bytes.writeUInt16LE(62, 18);
    writeFileSync(binary, bytes);
    expect(() => verifyElf(binary, "arm64")).toThrow();
    expect(() => verifyElf(binary, "x64")).not.toThrow();
  });

  it("admits an exact inventoried payload without executing bundled code", async () => {
    const { writeInventory, verifyPayload } = await api();
    const root = fixture();
    await writeInventory(root, metadata);
    expect(await verifyPayload(root, { arch: "arm64", version: "0.0.1" })).toMatchObject(metadata);
  });

  it.each(["bytes", "mode", "extra", "prototype-name", "missing", "symlink", "directory-mode"])(
    "rejects payload tampering: %s",
    async (kind) => {
      const { writeInventory, verifyPayload } = await api();
      const root = fixture();
      await writeInventory(root, metadata);
      const cli = join(root, "agent/dist/cli.js");
      if (kind === "bytes") writeFileSync(cli, "different");
      if (kind === "mode") chmodSync(cli, 0o755);
      if (kind === "extra") put(root, "unexpected", "extra");
      if (kind === "prototype-name") put(root, "__proto__", "must not disappear from inventory");
      if (kind === "missing") rmSync(cli);
      if (kind === "symlink") symlinkSync("agent/dist/cli.js", join(root, "alias"));
      if (kind === "directory-mode") chmodSync(join(root, "agent"), 0o777);
      await expect(verifyPayload(root)).rejects.toThrow();
    },
  );

  it.each(["../escape", "bad name", "bad\nname", "config.json"])(
    "rejects unsafe or state-bearing payload path %j",
    async (name) => {
      const { writeInventory, verifyPayload } = await api();
      const root = fixture();
      await writeInventory(root, metadata);
      const file = join(root, "inventory.json");
      const inventory = JSON.parse(readFileSync(file, "utf8"));
      inventory.files[name] = { sha256: "0".repeat(64), mode: 0o644 };
      writeFileSync(file, JSON.stringify(inventory));
      await expect(verifyPayload(root)).rejects.toThrow();
    },
  );

  it.each(["arch", "version", "runtimeVersion", "runtimeArchiveSha256", "sourceCommit", "extra"])(
    "rejects wrong provenance or format: %s",
    async (field) => {
      const { writeInventory, verifyPayload } = await api();
      const root = fixture();
      await writeInventory(root, metadata);
      const file = join(root, "inventory.json");
      const inventory = JSON.parse(readFileSync(file, "utf8"));
      inventory[field] = field === "version" ? "1.0.0" : "wrong";
      writeFileSync(file, JSON.stringify(inventory));
      await expect(verifyPayload(root)).rejects.toThrow();
    },
  );

  it("rejects a different expected target and preserves an existing inventory", async () => {
    const { writeInventory, verifyPayload } = await api();
    const root = fixture();
    await writeInventory(root, metadata);
    const before = readFileSync(join(root, "inventory.json"));
    await expect(verifyPayload(root, { arch: "x64" })).rejects.toThrow();
    await expect(writeInventory(root, metadata)).rejects.toThrow();
    expect(readFileSync(join(root, "inventory.json"))).toEqual(before);
  });
});
