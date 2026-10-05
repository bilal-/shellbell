import { chmodSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import {
  addonPath,
  addonVersion,
  candidatePath,
  metadata,
  nativeBytes,
  put,
  signedApi,
  signedFixture,
  teamId,
} from "./native-signed-fixture.js";

const roots: string[] = [];
function fixture() {
  const f = signedFixture();
  roots.push(f.root);
  return f;
}
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

it("inspects bundle structure without executing packaged code", async () => {
  const { inspectBundle } = await signedApi("package-lib");
  const f = fixture();
  await expect(inspectBundle(f.app, { run: f.run })).resolves.toEqual({
    arch: "arm64",
    version: "0.0.1",
    buildNumber: "1",
  });
  expect(f.runtimeCalls).toEqual([]);
});

it("round-trips strict candidate provenance and includes the signed helper bytes", async () => {
  const { createCandidateInventory, verifyCandidateInventory } =
    await signedApi("signed-inventory");
  const f = fixture();
  const record = createCandidateInventory(f.app, metadata);
  expect(record.format).toBe("shellbell-signed-candidate-v3");
  expect(record.dataChannelIdentifier).toBe("sh.bilal.shellbell.host.runtime.node-datachannel");
  expect(record.dataChannelVersion).toBe(addonVersion);
  expect(record.files[addonPath]).toBeDefined();
  expect(record.powerHelperIdentifier).toBe("sh.bilal.shellbell.power");
  expect(record.appIdentifier).toBe("sh.bilal.shellbell.host");
  expect(record.helperIdentifier).toBe("sh.bilal.shellbell.host.runtime.node");
  expect(record.files["Contents/Helpers/node"].mode).toBe(0o755);
  expect(record.files["Contents/MacOS/Shellbell"]).toBeUndefined();
  expect(record.files[candidatePath]).toBeUndefined();
  expect(verifyCandidateInventory(f.app, teamId)).toEqual(record);
  expect(() => createCandidateInventory(f.app, metadata)).toThrow();
});

it.each([
  "format",
  "arch",
  "runtimeVersion",
  "runtimeArchiveSha256",
  "sourceCommit",
  "developmentInventorySha256",
  "appIdentifier",
  "helperIdentifier",
  "powerHelperIdentifier",
  "dataChannelIdentifier",
  "dataChannelVersion",
  "teamId",
  "extra",
  "missing",
])("refuses invalid or unknown provenance field %s", async (field) => {
  const { createCandidateInventory, verifyCandidateInventory } =
    await signedApi("signed-inventory");
  const f = fixture();
  const record = createCandidateInventory(f.app, metadata);
  if (field === "missing") delete record.sourceCommit;
  else record[field] = "invalid";
  writeFileSync(join(f.app, candidatePath), JSON.stringify(record));
  expect(() => verifyCandidateInventory(f.app, teamId)).toThrow();
});

it("requires externally expected team rather than trusting the manifest", async () => {
  const { createCandidateInventory, verifyCandidateInventory } =
    await signedApi("signed-inventory");
  const f = fixture();
  createCandidateInventory(f.app, metadata);
  expect(() => verifyCandidateInventory(f.app, "OTHERTEAM1")).toThrow();
  expect(() => verifyCandidateInventory(f.app, "")).toThrow();
});

it.each(["extra", "missing", "changed", "helper", "addon", "mode", "link", "signature-sibling"])(
  "rejects %s payload mutation",
  async (kind) => {
    const { createCandidateInventory, verifyCandidateInventory } =
      await signedApi("signed-inventory");
    const f = fixture();
    createCandidateInventory(f.app, metadata);
    const resource = join(f.app, "Contents/Resources/runtime/LICENSE");
    if (kind === "extra") put(join(f.app, "Contents/Resources/unexpected"), "new");
    if (kind === "missing") rmSync(resource);
    if (kind === "changed") writeFileSync(resource, "changed");
    if (kind === "helper")
      writeFileSync(
        join(f.app, "Contents/Helpers/node"),
        Buffer.concat([nativeBytes, Buffer.from("changed")]),
      );
    if (kind === "addon")
      writeFileSync(join(f.app, addonPath), Buffer.concat([nativeBytes, Buffer.from("changed")]));
    if (kind === "mode") chmodSync(resource, 0o666);
    if (kind === "link") {
      rmSync(resource);
      put(join(f.root, "outside"), "outside");
      symlinkSync(join(f.root, "outside"), resource);
    }
    if (kind === "signature-sibling") put(join(f.app, "Contents/_CodeSignature/unsealed"), "new");
    expect(() => verifyCandidateInventory(f.app, teamId)).toThrow();
  },
);

it("limits signature exclusions to exact files, relying on later signature admission", async () => {
  const { createCandidateInventory, verifyCandidateInventory } =
    await signedApi("signed-inventory");
  const f = fixture();
  const before = createCandidateInventory(f.app, metadata);
  put(join(f.app, "Contents/_CodeSignature/CodeResources"), "outer seal");
  writeFileSync(
    join(f.app, "Contents/MacOS/Shellbell"),
    Buffer.concat([nativeBytes, Buffer.from("signature")]),
  );
  expect(verifyCandidateInventory(f.app, teamId)).toEqual(before);
  // Inventory alone deliberately does not prove validity of the outer signature.
});

it.each(["addon", "native-alias", "missing-main", "non-native-helper", "legacy-manifest"])(
  "refuses %s before writing candidate provenance",
  async (kind) => {
    const { createCandidateInventory } = await signedApi("signed-inventory");
    const f = fixture();
    if (kind === "addon") put(join(f.app, "Contents/Resources/addon.node"), nativeBytes);
    if (kind === "native-alias")
      symlinkSync("../Helpers/node", join(f.app, "Contents/Resources/alias"));
    if (kind === "missing-main") rmSync(join(f.app, "Contents/MacOS/Shellbell"));
    if (kind === "non-native-helper")
      writeFileSync(join(f.app, "Contents/Helpers/node"), "#!/bin/sh");
    if (kind === "legacy-manifest")
      put(join(f.app, "Contents/Resources/build-inventory.json"), "{}");
    expect(() => createCandidateInventory(f.app, metadata)).toThrow();
    expect(() => readFileSync(join(f.app, candidatePath))).toThrow();
  },
);

it.each(["symlink", "oversize", "legacy-manifest"])(
  "refuses %s candidate metadata",
  async (kind) => {
    const { createCandidateInventory, verifyCandidateInventory } =
      await signedApi("signed-inventory");
    const f = fixture();
    createCandidateInventory(f.app, metadata);
    const path = join(f.app, candidatePath);
    if (kind === "symlink") {
      put(join(f.root, "record"), readFileSync(path));
      rmSync(path);
      symlinkSync(join(f.root, "record"), path);
    }
    if (kind === "oversize") writeFileSync(path, " ".repeat(4 * 1024 * 1024 + 1));
    if (kind === "legacy-manifest")
      put(join(f.app, "Contents/Resources/build-inventory.json"), "{}");
    expect(() => verifyCandidateInventory(f.app, teamId)).toThrow();
  },
);

it.each(["missing-addon", "wrapper-version", "platform-version", "platform-name"])(
  "rejects %s before admitting the native WebRTC dependency",
  async (kind) => {
    const { createCandidateInventory } = await signedApi("signed-inventory");
    const f = fixture();
    if (kind === "missing-addon") rmSync(join(f.app, addonPath));
    else {
      const relative =
        kind === "wrapper-version"
          ? "Contents/Resources/agent/node_modules/node-datachannel/package.json"
          : addonPath.replace(/node_datachannel\.node$/, "package.json");
      const path = join(f.app, relative);
      const pkg = JSON.parse(readFileSync(path, "utf8"));
      if (kind === "platform-name") pkg.name = "@node-datachannel/darwin-x64";
      else pkg.version = "0.0.0";
      writeFileSync(path, JSON.stringify(pkg));
    }
    expect(() => createCandidateInventory(f.app, metadata)).toThrow();
    expect(() => readFileSync(join(f.app, candidatePath))).toThrow();
  },
);
