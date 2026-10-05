import { chmodSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import {
  metadata,
  nativeBytes,
  put,
  signedApi,
  signedFixture,
  teamId,
} from "./native-signed-fixture.js";

const roots: string[] = [];
const helper = "Contents/Library/HelperTools/ShellbellPowerHelper";
const daemon = "Contents/Library/LaunchDaemons/sh.bilal.shellbell.power.plist";
const definition = {
  Label: "sh.bilal.shellbell.power",
  BundleProgram: helper,
  ProgramArguments: ["ShellbellPowerHelper"],
  UserName: "root",
  MachServices: { "sh.bilal.shellbell.power": true },
  RunAtLoad: true,
  KeepAlive: true,
  ProcessType: "Background",
  ThrottleInterval: 10,
  ExitTimeOut: 20,
};
function fixture() {
  const f = signedFixture();
  roots.push(f.root);
  put(join(f.app, helper), nativeBytes);
  chmodSync(join(f.app, helper), 0o755);
  put(join(f.app, daemon), JSON.stringify(definition));
  return f;
}
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

it.each([helper, daemon])(
  "requires power component %s before any packaged execution",
  async (path) => {
    const { inspectBundle } = await signedApi("package-lib");
    const f = fixture();
    rmSync(join(f.app, path));
    await expect(inspectBundle(f.app, { run: f.run })).rejects.toThrow();
    expect(f.runtimeCalls).toEqual([]);
  },
);

it.each([
  "Label",
  "BundleProgram",
  "ProgramArguments",
  "UserName",
  "MachServices",
  "KeepAlive",
  "extra",
])("rejects changed power daemon %s", async (key) => {
  const { inspectBundle } = await signedApi("package-lib");
  const f = fixture();
  put(join(f.app, daemon), JSON.stringify({ ...definition, [key]: "changed" }));
  await expect(inspectBundle(f.app, { run: f.run })).rejects.toThrow();
  expect(f.runtimeCalls).toEqual([]);
});

it("rejects a mismatched power helper architecture", async () => {
  const { inspectBundle } = await signedApi("package-lib");
  const f = fixture();
  const run = (file: string, args: string[]) =>
    file === "/usr/bin/lipo" && args.at(-1)?.endsWith("ShellbellPowerHelper")
      ? Promise.resolve("x86_64")
      : f.run(file, args);
  await expect(inspectBundle(f.app, { run })).rejects.toMatchObject({
    code: "runtime-architecture",
  });
});

it("seals signed power bytes and rejects substitution without broad signature exclusions", async () => {
  const { createCandidateInventory, verifyCandidateInventory } =
    await signedApi("signed-inventory");
  const f = fixture();
  const record = createCandidateInventory(f.app, metadata);
  expect(record.files[helper]?.mode).toBe(0o755);
  expect(record.files[daemon]?.sha256).toMatch(/^[a-f0-9]{64}$/);
  expect(verifyCandidateInventory(f.app, teamId)).toEqual(record);
  writeFileSync(
    join(f.app, helper),
    Buffer.concat([readFileSync(join(f.app, helper)), Buffer.from("substitution")]),
  );
  expect(() => verifyCandidateInventory(f.app, teamId)).toThrow();
});
