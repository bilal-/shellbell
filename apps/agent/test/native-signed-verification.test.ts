import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { metadata, signedApi, signedFixture, teamId } from "./native-signed-fixture.js";

type Options = { env?: Record<string, string>; cwd?: string; timeout?: number; maxBuffer?: number };
type Call = { file: string; args: string[]; options: Options };
const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
async function fixture(failure?: string) {
  const f = signedFixture();
  roots.push(f.root);
  const { createCandidateInventory } = await signedApi("signed-inventory");
  createCandidateInventory(f.app, metadata);
  const calls: Call[] = [];
  const run = async (file: string, args: string[], options: Options = {}) => {
    calls.push({ file, args, options });
    const target = args.at(-1)!;
    if (file === "/usr/bin/codesign") {
      const helper = target.endsWith("/Helpers/node");
      const power = target.endsWith("/HelperTools/ShellbellPowerHelper");
      const addon = target.endsWith("/node_datachannel.node");
      if (args.includes("--verify")) {
        if (failure === "addon-signature" && addon) throw Error("untrusted addon signature");
        if (failure === "power-signature" && power) throw Error("untrusted power signature");
        if (
          (failure === "helper-signature" && helper) ||
          (failure === "app-signature" && !helper && !power && !addon)
        )
          throw Error("untrusted signature");
        return { stdout: "", stderr: "" };
      }
      if (args.includes("--entitlements")) {
        const data: Record<string, unknown> = helper
          ? { "com.apple.security.cs.allow-jit": true }
          : {};
        if (failure === "extra-entitlement") data["com.apple.security.get-task-allow"] = true;
        if (failure === "false-jit" && helper) data["com.apple.security.cs.allow-jit"] = false;
        if (failure === "app-jit" && !helper && !power && !addon)
          data["com.apple.security.cs.allow-jit"] = true;
        if (failure === "addon-jit" && addon) data["com.apple.security.cs.allow-jit"] = true;
        if (failure === "power-jit" && power) data["com.apple.security.cs.allow-jit"] = true;
        return {
          stdout: failure === "malformed-entitlements" ? "bad" : JSON.stringify(data),
          stderr: "",
        };
      }
      return {
        stdout: "",
        stderr: [
          `Identifier=${failure === "wrong-id" ? "wrong" : addon ? "sh.bilal.shellbell.host.runtime.node-datachannel" : helper ? "sh.bilal.shellbell.host.runtime.node" : power ? "sh.bilal.shellbell.power" : "sh.bilal.shellbell.host"}`,
          `TeamIdentifier=${failure === "wrong-team" || (failure === "power-team" && power) || (failure === "addon-team" && addon) ? "OTHERTEAM1" : teamId}`,
          `CodeDirectory v=20500 size=500 flags=0x${failure === "no-runtime" ? "0" : failure === "power-ad-hoc" && power ? "10002" : "10000"}(runtime) hashes=1+7 location=embedded`,
          failure === "no-timestamp"
            ? "Signed Time=Sep 24, 2026"
            : "Timestamp=Sep 24, 2026 at 12:00:00 PM",
        ].join("\n"),
      };
    }
    if (
      file === "/usr/bin/lipo" &&
      failure === "addon-arch" &&
      args.at(-1)?.endsWith("/node_datachannel.node")
    )
      return { stdout: "x86_64", stderr: "" };
    if (file.endsWith("/Helpers/node")) {
      f.runtimeCalls.push(args.join(" "));
      if (failure === "runtime-state") writeFileSync(join(options.cwd!, "unexpected"), "state");
      if (failure === "app-mutation")
        writeFileSync(join(f.app, "Contents/MacOS/Shellbell"), "mutated");
      if (failure === "legacy-after-probe")
        writeFileSync(join(f.app, "Contents/Resources/build-inventory.json"), "{}");
      if (failure === "addon-load" && args.length > 2) throw Error("addon rejected");
      if (failure === "runtime-error") throw Error("runtime failed");
      return {
        stdout:
          args[0] === "--version"
            ? failure === "wrong-version"
              ? "v20.0.0"
              : "v22.23.1"
            : failure === "wrong-js"
              ? "wrong"
              : args.length > 2
                ? "shellbell-candidate-datachannel-ok"
                : "shellbell-candidate-runtime-ok",
        stderr: "",
      };
    }
    return { stdout: await f.run(file, args), stderr: "" };
  };
  return { ...f, calls, run };
}

it("verifies explicit publisher requirements and policy before isolated runtime probes", async () => {
  const { verifySignedCandidate } = await signedApi("signed-verification");
  const f = await fixture();
  const result = await verifySignedCandidate(f.app, { teamId, run: f.run });
  expect(result).toMatchObject({
    arch: "arm64",
    version: "0.0.1",
    teamId,
    notarized: false,
    releaseReady: false,
  });
  const verification = f.calls.filter(
    (c) => c.file === "/usr/bin/codesign" && c.args.includes("--verify"),
  );
  expect(verification).toHaveLength(4);
  expect(verification.map((call) => call.args.at(-1))).toContain(
    join(f.app, "Contents/Library/HelperTools/ShellbellPowerHelper"),
  );
  for (const call of verification) {
    expect(call.args).toContain("--strict");
    const requirement = call.args[call.args.indexOf("--test-requirement") + 1];
    expect(requirement).toMatch(/^=anchor apple generic/);
    expect(requirement).toContain("certificate leaf[field.1.2.840.113635.100.6.1.13] exists");
    expect(requirement).toContain('certificate leaf[subject.OU] = "TESTTEAM01"');
  }
  const firstRuntime = f.calls.findIndex((c) => c.file.endsWith("/Helpers/node"));
  expect(f.calls.slice(firstRuntime).filter((c) => c.file === "/usr/bin/codesign")).toEqual([]);
  expect(f.runtimeCalls).toHaveLength(3);
  for (const call of f.calls.filter((c) => c.file.endsWith("/Helpers/node"))) {
    expect(call.options.env?.NODE_OPTIONS).toBeUndefined();
    expect(call.options.env?.HOME).toBe(call.options.cwd);
    expect(call.options.timeout).toBe(5000);
    expect(call.options.maxBuffer).toBe(65536);
    expect(existsSync(call.options.cwd!)).toBe(false);
  }
});

it.each([
  "helper-signature",
  "addon-signature",
  "addon-arch",
  "addon-team",
  "addon-jit",
  "power-signature",
  "power-team",
  "power-jit",
  "power-ad-hoc",
  "app-signature",
  "wrong-id",
  "wrong-team",
  "no-runtime",
  "no-timestamp",
  "extra-entitlement",
  "false-jit",
  "app-jit",
  "malformed-entitlements",
])("rejects %s before executing bundled code", async (failure) => {
  const { verifySignedCandidate } = await signedApi("signed-verification");
  const f = await fixture(failure);
  await expect(verifySignedCandidate(f.app, { teamId, run: f.run })).rejects.toThrow();
  expect(f.runtimeCalls).toEqual([]);
});

it.each([
  "wrong-version",
  "wrong-js",
  "runtime-error",
  "addon-load",
  "runtime-state",
  "app-mutation",
  "legacy-after-probe",
])("fails closed on %s after admission and cleans only its own probe state", async (failure) => {
  const { verifySignedCandidate } = await signedApi("signed-verification");
  const f = await fixture(failure);
  await expect(verifySignedCandidate(f.app, { teamId, run: f.run })).rejects.toThrow();
  expect(f.runtimeCalls.length).toBeGreaterThan(0);
  for (const call of f.calls.filter((c) => c.file.endsWith("/Helpers/node")))
    expect(existsSync(call.options.cwd!)).toBe(false);
  expect(existsSync(f.app)).toBe(true);
});

it("rejects a wrong externally expected team without invoking signature or runtime commands", async () => {
  const { verifySignedCandidate } = await signedApi("signed-verification");
  const f = await fixture();
  await expect(
    verifySignedCandidate(f.app, { teamId: "OTHERTEAM1", run: f.run }),
  ).rejects.toThrow();
  expect(
    f.calls.some((c) => c.file === "/usr/bin/codesign" || c.file.endsWith("/Helpers/node")),
  ).toBe(false);
});

it.each(["exit", "timeout", "overflow"])("real command adapter rejects %s", async (kind) => {
  const { runCaptured } = await signedApi("signed-verification");
  const script =
    kind === "exit"
      ? "process.exit(4)"
      : kind === "timeout"
        ? "setInterval(()=>{},1000)"
        : "process.stdout.write('x'.repeat(1000000))";
  await expect(
    runCaptured(process.execPath, ["-e", script], {
      timeout: kind === "timeout" ? 100 : 5000,
      maxBuffer: 1024,
    }),
  ).rejects.toThrow();
});

it("real command adapter clears ambient injection variables and returns both output channels", async () => {
  const { runCaptured } = await signedApi("signed-verification");
  const result = await runCaptured(process.execPath, [
    "-e",
    "process.stdout.write(String(process.env.NODE_OPTIONS));process.stderr.write('diagnostic')",
  ]);
  expect(result).toEqual({ stdout: "undefined", stderr: "diagnostic" });
});

it("forces terminal timeout failure even when a child handles SIGTERM and later exits zero", async () => {
  const { runCaptured } = await signedApi("signed-verification");
  await expect(
    runCaptured(
      process.execPath,
      ["-e", 'process.on("SIGTERM",()=>{});setTimeout(()=>process.exit(0),1500);'],
      { timeout: 200 },
    ),
  ).rejects.toMatchObject({ signal: "SIGKILL" });
});

it.each([0, -1, Infinity, 60001])(
  "refuses disabled or out-of-policy timeout %s",
  async (timeout) => {
    const { runCaptured } = await signedApi("signed-verification");
    await expect(runCaptured(process.execPath, ["-e", ""], { timeout })).rejects.toMatchObject({
      code: "signature-command-timeout",
    });
  },
);

it("executes the generated numeric smoke script on real host Node without service code", async () => {
  const { verifySignedCandidate, runCaptured } = await signedApi("signed-verification");
  const f = await fixture();
  let scriptsRun = 0;
  const run = async (file: string, args: string[], options: Options = {}) => {
    if (file.endsWith("/Helpers/node") && args[0] === "-e" && args.length === 2) {
      scriptsRun++;
      return runCaptured(process.execPath, args, options);
    }
    return f.run(file, args, options);
  };
  await expect(verifySignedCandidate(f.app, { teamId, run })).resolves.toMatchObject({
    releaseReady: false,
  });
  expect(scriptsRun).toBe(1);
});

it("does not accept a tampered candidate simply because signature stubs say success", async () => {
  const { verifySignedCandidate } = await signedApi("signed-verification");
  const f = await fixture();
  const path = join(f.app, "Contents/Resources/runtime/LICENSE");
  writeFileSync(path, `${readFileSync(path, "utf8")}tampered`);
  await expect(verifySignedCandidate(f.app, { teamId, run: f.run })).rejects.toThrow();
  expect(f.runtimeCalls).toEqual([]);
});
