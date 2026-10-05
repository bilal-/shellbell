import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { afterEach, expect, it } from "vitest";
import {
  addonPath,
  candidatePath,
  metadata,
  nativeBytes,
  put,
  signedApi,
  signedFixture,
  teamId,
} from "./native-signed-fixture.js";

const roots: string[] = [];
const identitySha1 = "c".repeat(40);
type Call = { file: string; args: string[] };
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
async function fixture(failure?: string) {
  const f = signedFixture();
  roots.push(f.root);
  const { writeInventory, fileInventory } = await signedApi("package-lib");
  await writeInventory(f.app, {
    arch: "arm64",
    buildNumber: "1",
    sourceCommit: metadata.sourceCommit,
    runtimeArchiveSha256: metadata.runtimeArchiveSha256,
  });
  const calls: Call[] = [];
  const output = join(f.root, "candidate");
  let sealed: string | undefined;
  const signInputs: string[] = [];
  const run = async (file: string, args: string[]) => {
    calls.push({ file, args });
    const target = args.at(-1)!;
    if (file === "/usr/bin/codesign") {
      const helper = target.endsWith("/Helpers/node");
      const power = target.endsWith("/HelperTools/ShellbellPowerHelper");
      const addon = target.endsWith("/node_datachannel.node");
      if (args.includes("--sign")) {
        if (
          (failure === "addon-sign" && addon) ||
          (failure === "helper-sign" && helper) ||
          (failure === "outer-sign" && !helper && !power && !addon)
        )
          throw Error("signing rejected");
        const entitlementPath = args[args.indexOf("--entitlements") + 1];
        if (!entitlementPath) throw Error("missing explicit signing entitlements");
        signInputs.push(readFileSync(entitlementPath, "utf8"));
        if (helper || power || addon)
          writeFileSync(
            target,
            Buffer.concat([readFileSync(target), Buffer.from("signed helper")]),
          );
        else {
          expect(existsSync(join(target, candidatePath))).toBe(true);
          expect(existsSync(join(target, "Contents/Resources/build-inventory.json"))).toBe(false);
          const main = join(target, "Contents/MacOS/Shellbell");
          writeFileSync(main, Buffer.concat([readFileSync(main), Buffer.from("signed app")]));
          put(join(target, "Contents/_CodeSignature/CodeResources"), "signature resources");
          sealed = JSON.stringify(fileInventory(target));
        }
        return { stdout: "", stderr: "" };
      }
      if (args.includes("--verify")) {
        if (failure === "verify") throw Error("signature rejected");
        if (!helper && !power && !addon) expect(JSON.stringify(fileInventory(target))).toBe(sealed);
        return { stdout: "", stderr: "" };
      }
      if (args.includes("--entitlements"))
        return {
          stdout: JSON.stringify(helper ? { "com.apple.security.cs.allow-jit": true } : {}),
          stderr: "",
        };
      return {
        stdout: "",
        stderr: [
          `Identifier=${addon ? "sh.bilal.shellbell.host.runtime.node-datachannel" : helper ? "sh.bilal.shellbell.host.runtime.node" : power ? "sh.bilal.shellbell.power" : "sh.bilal.shellbell.host"}`,
          `TeamIdentifier=${teamId}`,
          "CodeDirectory v=20500 size=500 flags=0x10000(runtime) hashes=1+7 location=embedded",
          "Timestamp=Sep 24, 2026 at 12:00:00 PM",
        ].join("\n"),
      };
    }
    if (file.endsWith("/Helpers/node") && sealed) {
      if (failure === "runtime") throw Error("runtime rejected");
      return {
        stdout:
          args[0] === "--version"
            ? "v22.23.1"
            : args.length > 2
              ? "shellbell-candidate-datachannel-ok"
              : "shellbell-candidate-runtime-ok",
        stderr: "",
      };
    }
    return { stdout: await f.run(file, args), stderr: "" };
  };
  return { ...f, output, calls, run, signInputs, sealed: () => sealed };
}

it("signs only a verified copy inside-out and records final bytes after all checks", async () => {
  const { signCandidate } = await signedApi("signed-candidate");
  const { fileInventory, verifyBundle, makeDmg } = await signedApi("package-lib");
  const f = await fixture();
  const before = JSON.stringify(fileInventory(f.app));
  const originalInventory = readFileSync(join(f.app, "Contents/Resources/build-inventory.json"));
  const report = await signCandidate(
    { app: f.app, output: f.output, identitySha1, teamId },
    { run: f.run },
  );
  expect(report).toMatchObject({
    notarized: false,
    releaseReady: false,
    teamId,
    sourceCommit: metadata.sourceCommit,
  });
  const app = join(f.output, "Shellbell.app");
  expect(JSON.stringify(fileInventory(f.app))).toBe(before);
  expect(readFileSync(join(f.app, "Contents/Resources/build-inventory.json"))).toEqual(
    originalInventory,
  );
  expect(JSON.stringify(fileInventory(app))).toBe(f.sealed());
  const signCalls = f.calls.filter((c) => c.args.includes("--sign"));
  expect(signCalls.map((c) => c.args.at(-1))).toEqual([
    join(app, addonPath),
    join(app, "Contents/Helpers/node"),
    join(app, "Contents/Library/HelperTools/ShellbellPowerHelper"),
    app,
  ]);
  for (const call of signCalls) {
    expect(call.args).toContain(identitySha1);
    expect(call.args).toContain("--timestamp");
    expect(call.args[call.args.indexOf("--options") + 1]).toBe("runtime");
    expect(call.args).not.toContain("--deep");
    expect(call.args).not.toContain("--preserve-metadata");
  }
  expect(signCalls[0]!.args[signCalls[0]!.args.indexOf("--identifier") + 1]).toBe(
    "sh.bilal.shellbell.host.runtime.node-datachannel",
  );
  expect(signCalls[1]!.args[signCalls[1]!.args.indexOf("--identifier") + 1]).toBe(
    "sh.bilal.shellbell.host.runtime.node",
  );
  expect(signCalls[2]!.args[signCalls[2]!.args.indexOf("--identifier") + 1]).toBe(
    "sh.bilal.shellbell.power",
  );
  expect(signCalls[3]!.args[signCalls[3]!.args.indexOf("--identifier") + 1]).toBe(
    "sh.bilal.shellbell.host",
  );
  expect(f.signInputs[0]).not.toContain("com.apple.security.cs.allow-jit");
  expect(f.signInputs[1]).toContain("com.apple.security.cs.allow-jit");
  expect(f.signInputs[2]).not.toContain("com.apple.security.cs.allow-jit");
  expect(f.signInputs.join("\n")).not.toMatch(
    /get-task-allow|disable-library-validation|unsigned-executable/,
  );
  const stored = JSON.parse(readFileSync(join(f.output, "candidate-report.json"), "utf8"));
  expect(stored).toEqual(report);
  expect(stored.files).toEqual(fileInventory(app));
  expect(stored.files["Contents/MacOS/Shellbell"]).toBeDefined();
  expect(stored.files["Contents/_CodeSignature/CodeResources"]).toBeDefined();
  const legacyRun = async (file: string, args: string[]) => (await f.run(file, args)).stdout;
  await expect(verifyBundle(app, { run: legacyRun })).rejects.toMatchObject({ code: "ENOENT" });
  await expect(makeDmg(app, join(f.root, "wrong.dmg"), { run: legacyRun })).rejects.toMatchObject({
    code: "ENOENT",
  });
  expect(existsSync(join(f.root, "wrong.dmg"))).toBe(false);
});

it.each(["addon-sign", "helper-sign", "outer-sign", "verify", "runtime"])(
  "leaves no success report after %s failure and preserves input",
  async (failure) => {
    const { signCandidate } = await signedApi("signed-candidate");
    const { fileInventory } = await signedApi("package-lib");
    const f = await fixture(failure);
    const before = JSON.stringify(fileInventory(f.app));
    await expect(
      signCandidate({ app: f.app, output: f.output, identitySha1, teamId }, { run: f.run }),
    ).rejects.toThrow();
    expect(existsSync(join(f.output, "candidate-report.json"))).toBe(false);
    expect(JSON.stringify(fileInventory(f.app))).toBe(before);
    expect(existsSync(join(f.app, "Contents/Resources/build-inventory.json"))).toBe(true);
  },
);

it.each(["existing-output", "nested-output", "bad-identity", "bad-team", "extra-native"])(
  "rejects %s before signing",
  async (kind) => {
    const { signCandidate } = await signedApi("signed-candidate");
    const { writeInventory } = await signedApi("package-lib");
    const f = await fixture();
    let output = f.output;
    if (kind === "existing-output") output = f.root;
    if (kind === "nested-output") output = join(f.app, "candidate");
    if (kind === "extra-native") {
      put(join(f.app, "Contents/Resources/addon.node"), nativeBytes);
      rmSync(join(f.app, "Contents/Resources/build-inventory.json"));
      await writeInventory(f.app, {
        arch: "arm64",
        buildNumber: "1",
        sourceCommit: metadata.sourceCommit,
        runtimeArchiveSha256: metadata.runtimeArchiveSha256,
      });
    }
    await expect(
      signCandidate(
        {
          app: f.app,
          output,
          identitySha1: kind === "bad-identity" ? "-" : identitySha1,
          teamId: kind === "bad-team" ? "bad" : teamId,
        },
        { run: f.run },
      ),
    ).rejects.toThrow();
    expect(f.calls.filter((c) => c.args.includes("--sign"))).toEqual([]);
    if (kind !== "extra-native") expect(f.calls).toEqual([]);
  },
);

it("parses only explicit complete options with no duplicate or implicit identity", async () => {
  const { parseCandidateArgs } = await signedApi("signed-candidate");
  const args = [
    "--app",
    "/tmp/Shellbell.app",
    "--output",
    "/tmp/candidate",
    "--identity-sha1",
    identitySha1,
    "--team-id",
    teamId,
  ];
  expect(parseCandidateArgs(args, "sign")).toEqual({
    app: "/tmp/Shellbell.app",
    output: "/tmp/candidate",
    identitySha1,
    teamId,
  });
  expect(
    parseCandidateArgs(["--app", "/tmp/Shellbell.app", "--team-id", teamId], "verify"),
  ).toEqual({ app: "/tmp/Shellbell.app", teamId });
  for (const bad of [
    args.slice(0, -2),
    [...args, "--team-id", teamId],
    [...args, "--unknown", "value"],
    ["--app"],
    ["--app", "relative", "--team-id", teamId],
  ])
    expect(() => parseCandidateArgs(bad, "sign")).toThrow();
});

it.each(["sign-candidate", "verify-signed-candidate"])(
  "%s CLI help and bad arguments never start a workflow",
  (name) => {
    const script = resolve(`../macos/scripts/${name}.mjs`);
    expect(execFileSync(process.execPath, [script, "--help"], { encoding: "utf8" })).toContain(
      "--team-id",
    );
    expect(() =>
      execFileSync(process.execPath, [script, "--unknown", "value"], { stdio: "pipe" }),
    ).toThrow();
  },
);
