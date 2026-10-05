import { createHash } from "node:crypto";
import {
  chmodSync,
  cpSync,
  existsSync,
  readFileSync,
  rmSync,
  symlinkSync,
  truncateSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { metadata, signedApi, signedFixture, teamId } from "./native-signed-fixture.js";

const imageId = "sh.bilal.shellbell.host.disk-image";
const readme =
  "Shellbell\nCopy Shellbell.app to Applications. Opening the app does not enable a future-login service without explicit consent.\nTo remove: explicitly stop/disable the service in Shellbell, quit the UI, then remove the app. Preserve keys/configuration unless you separately choose to delete them.\n";
const roots: string[] = [];
const identitySha1 = "a".repeat(40);

it("writes detached final-byte evidence only after successful verification", async () => {
  const f = await fixture();
  const { verifySignedDmgReport } = await signedApi("signed-dmg");
  const reportPath = join(f.root, "final-report.json");
  const report = await verifySignedDmgReport(
    {
      image: f.image,
      teamId,
      stage: "candidate",
      report: reportPath,
    },
    { run: f.run },
  );
  expect(JSON.parse(readFileSync(reportPath, "utf8"))).toEqual(report);
  expect(f.calls.at(-1)!.args).toEqual(["detach", f.mount()]);
});

it("refuses an existing report before mounting or overwriting it", async () => {
  const f = await fixture();
  const { verifySignedDmgReport } = await signedApi("signed-dmg");
  const report = join(f.root, "existing.json");
  writeFileSync(report, "keep this");
  await expect(
    verifySignedDmgReport({ image: f.image, teamId, stage: "candidate", report }, { run: f.run }),
  ).rejects.toThrow();
  expect(readFileSync(report, "utf8")).toBe("keep this");
  expect(f.calls).toEqual([]);
});

it("leaves no detached report after failed publisher admission", async () => {
  const f = await fixture("outer-signature");
  const { verifySignedDmgReport } = await signedApi("signed-dmg");
  const report = join(f.root, "rejected.json");
  await expect(
    verifySignedDmgReport({ image: f.image, teamId, stage: "candidate", report }, { run: f.run }),
  ).rejects.toThrow();
  expect(existsSync(report)).toBe(false);
});
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

it("builds a separate image, signs explicitly and reports only the inspected payload", async () => {
  const f = await fixture();
  const { buildSignedDmg } = await signedApi("signed-dmg");
  const { fileInventory } = await signedApi("package-lib");
  const before = fileInventory(f.app);
  const output = join(f.root, "output");
  const report = await buildSignedDmg({ app: f.app, output, teamId, identitySha1 }, { run: f.run });
  expect(report).toMatchObject({
    image: join(output, "Shellbell.dmg"),
    appFiles: before,
    stage: "candidate",
    notarized: false,
    releaseReady: false,
  });
  expect(JSON.parse(readFileSync(join(output, "signed-dmg-report.json"), "utf8"))).toEqual(report);
  expect(fileInventory(f.app)).toEqual(before);
  const signs = f.calls.filter((call) => call.args.includes("--sign"));
  expect(signs).toHaveLength(1);
  expect(signs[0]!.args).toEqual([
    "--force",
    "--timestamp",
    "--identifier",
    imageId,
    "--sign",
    identitySha1,
    join(output, "Shellbell.dmg"),
  ]);
  const createIndex = f.calls.findIndex((call) => call.args[0] === "create");
  expect(createIndex).toBeGreaterThan(0);
  expect(f.calls.indexOf(signs[0]!)).toBeGreaterThan(createIndex);
  expect(f.calls.at(-1)!.args).toEqual(["detach", f.mount()]);
});

it.each(["create", "sign", "tampered-app", "detach", "input-mutation"])(
  "preserves partial output without a success report after %s",
  async (failure) => {
    const f = await fixture(failure);
    const { buildSignedDmg } = await signedApi("signed-dmg");
    const output = join(f.root, "output");
    await expect(
      buildSignedDmg({ app: f.app, output, teamId, identitySha1 }, { run: f.run }),
    ).rejects.toThrow();
    expect(existsSync(join(output, "Shellbell.dmg"))).toBe(true);
    expect(existsSync(join(output, "signed-dmg-report.json"))).toBe(false);
  },
);

it.each(["existing", "nested", "identity"])(
  "rejects %s builder options before commands",
  async (failure) => {
    const f = await fixture();
    const { buildSignedDmg } = await signedApi("signed-dmg");
    const output =
      failure === "existing"
        ? f.root
        : failure === "nested"
          ? join(f.app, "output")
          : join(f.root, "output");
    await expect(
      buildSignedDmg(
        {
          app: f.app,
          output,
          teamId,
          identitySha1: failure === "identity" ? "-" : identitySha1,
        },
        { run: f.run },
      ),
    ).rejects.toThrow();
    expect(f.calls).toEqual([]);
  },
);
async function fixture(failure = "") {
  const f = signedFixture();
  roots.push(f.root);
  const inventory = await signedApi("signed-inventory");
  inventory.createCandidateInventory(f.app, metadata);
  const image = join(f.root, "Shellbell.dmg");
  writeFileSync(image, "signed image fixture");
  const calls: { file: string; args: string[] }[] = [];
  let mount = "";
  let imageVolume = "";
  const run = async (file: string, args: string[]) => {
    calls.push({ file, args });
    const target = args.at(-1)!;
    if (file === "/usr/bin/codesign") {
      const disk = target.endsWith(".dmg");
      const helper = target.endsWith("/Helpers/node");
      const power = target.endsWith("/HelperTools/ShellbellPowerHelper");
      const addon = target.endsWith("/node_datachannel.node");
      if (args.includes("--sign")) {
        if (failure === "sign") throw Error("sign failed");
        return { stdout: "", stderr: "" };
      }
      if (args.includes("--verify")) {
        if ((disk && failure === "outer-signature") || (!disk && failure === "inner-signature"))
          throw Error("publisher rejected");
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
          `Identifier=${disk ? (failure === "wrong-id" ? "wrong" : imageId) : addon ? "sh.bilal.shellbell.host.runtime.node-datachannel" : helper ? "sh.bilal.shellbell.host.runtime.node" : power ? "sh.bilal.shellbell.power" : "sh.bilal.shellbell.host"}`,
          `TeamIdentifier=${disk && failure === "wrong-team" ? "OTHERTEAM1" : teamId}`,
          `CodeDirectory v=20500 size=500 flags=0x${disk ? "0" : "10000"} hashes=1+7 location=embedded`,
          disk && failure === "no-timestamp" ? "Signed Time=today" : "Timestamp=Sep 24, 2026",
        ].join("\n"),
      };
    }
    if (file === "/usr/bin/hdiutil") {
      if (args[0] === "create") {
        writeFileSync(target, "signed image fixture");
        if (failure === "create") throw Error("create failed");
        imageVolume = join(f.root, "created-volume");
        cpSync(args[args.indexOf("-srcfolder") + 1]!, imageVolume, {
          recursive: true,
          verbatimSymlinks: true,
        });
        if (failure === "input-mutation")
          writeFileSync(join(f.app, "Contents/Resources/runtime/LICENSE"), "changed input");
        return { stdout: "", stderr: "" };
      }
      if (args[0] === "imageinfo")
        return {
          stdout: JSON.stringify({
            Format: "UDZO",
            Properties: { Checksummed: true, Compressed: true, Encrypted: false },
            "Size Information": { "Total Bytes": 1024 * 1024 },
          }),
          stderr: "",
        };
      if (args[0] === "verify") return { stdout: "", stderr: "" };
      if (args[0] === "attach") {
        mount = args[args.indexOf("-mountpoint") + 1]!;
        roots.push(dirname(mount));
        if (imageVolume) cpSync(imageVolume, mount, { recursive: true, verbatimSymlinks: true });
        else {
          cpSync(f.app, join(mount, "Shellbell.app"), { recursive: true });
          symlinkSync(
            failure === "wrong-link" ? "/tmp" : "/Applications",
            join(mount, "Applications"),
          );
          writeFileSync(join(mount, "READ-ME.txt"), failure === "wrong-readme" ? "wrong" : readme);
        }
        if (failure === "extra-item") writeFileSync(join(mount, "extra"), "unapproved");
        if (failure === "tampered-app")
          writeFileSync(
            join(mount, "Shellbell.app/Contents/Resources/agent/dist/cli.js"),
            "tampered",
          );
        return {
          stdout: JSON.stringify({
            "system-entities": [
              {
                "mount-point": mount,
                "volume-kind": "hfs",
                "content-hint": "Apple_HFS",
                "potentially-mountable": true,
              },
            ],
          }),
          stderr: "",
        };
      }
      if (args[0] === "detach") {
        if (failure === "detach") throw Error("busy");
        if (failure === "image-mutation") writeFileSync(image, "different image");
        return { stdout: "", stderr: "" };
      }
    }
    if (file === "/usr/bin/xcrun") {
      expect(args).toEqual(["stapler", "validate", image]);
      if (failure === "stapler") throw Error("ticket invalid");
      return { stdout: "", stderr: "" };
    }
    if (file === "/usr/sbin/spctl") {
      if (args[0] === "--status")
        return {
          stdout: failure === "disabled" ? "assessments disabled\n" : "assessments enabled\n",
          stderr: "",
        };
      if (failure === "assessment") throw Error("rejected");
      return {
        stdout: "",
        stderr: `${target}: accepted\nsource=${failure === "unnotarized" ? "Developer ID" : "Notarized Developer ID"}\n`,
      };
    }
    if (file.endsWith("/Helpers/node")) {
      f.runtimeCalls.push(file);
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
  return { ...f, image, calls, run, mount: () => mount };
}

it("rejects outer publisher failure before image inspection, mount or packaged execution", async () => {
  const f = await fixture("outer-signature");
  const { verifySignedDmg } = await signedApi("signed-dmg");
  await expect(
    verifySignedDmg({ image: f.image, teamId, stage: "candidate" }, { run: f.run }),
  ).rejects.toThrow("publisher rejected");
  expect(f.calls.map((call) => call.file)).toEqual(["/usr/bin/codesign"]);
  expect(f.runtimeCalls).toEqual([]);
});

it("verifies the delivered app and returns final bytes only after detach", async () => {
  const f = await fixture();
  const { verifySignedDmg } = await signedApi("signed-dmg");
  const report = await verifySignedDmg(
    { image: f.image, teamId, stage: "candidate" },
    { run: f.run },
  );
  expect(report).toMatchObject({
    stage: "candidate",
    teamId,
    notarized: false,
    releaseReady: false,
    arch: "arm64",
    sha256: createHash("sha256").update("signed image fixture").digest("hex"),
  });
  expect(report.appFiles["Contents/Resources/signed-candidate.json"]).toBeDefined();
  expect(f.calls.at(-1)!.args).toEqual(["detach", f.mount()]);
  expect(existsSync(dirname(f.mount()))).toBe(false);
  expect(f.runtimeCalls.length).toBe(3);
  expect(f.runtimeCalls.every((path) => path.startsWith(f.mount()))).toBe(true);
  const outer = f.calls[0]!;
  expect(outer.args).toContain("--strict");
  const requirement = outer.args[outer.args.indexOf("--test-requirement") + 1]!;
  expect(requirement).toContain(`identifier "${imageId}"`);
  expect(requirement).toContain('certificate leaf[subject.OU] = "TESTTEAM01"');
  expect(requirement).toContain("anchor apple generic");
  expect(
    f.calls.some((call) => call.file === "/usr/bin/xcrun" || call.file === "/usr/sbin/spctl"),
  ).toBe(false);
});

it.each(["wrong-id", "wrong-team", "no-timestamp"])(
  "rejects %s before mounting",
  async (failure) => {
    const f = await fixture(failure);
    const { verifySignedDmg } = await signedApi("signed-dmg");
    await expect(
      verifySignedDmg({ image: f.image, teamId, stage: "candidate" }, { run: f.run }),
    ).rejects.toThrow();
    expect(f.calls.every((call) => call.file === "/usr/bin/codesign")).toBe(true);
    expect(f.runtimeCalls).toEqual([]);
  },
);

it.each(["extra-item", "wrong-link", "wrong-readme", "tampered-app", "inner-signature"])(
  "rejects %s in mounted content without executing it and detaches",
  async (failure) => {
    const f = await fixture(failure);
    const { verifySignedDmg } = await signedApi("signed-dmg");
    await expect(
      verifySignedDmg({ image: f.image, teamId, stage: "candidate" }, { run: f.run }),
    ).rejects.toThrow();
    expect(f.runtimeCalls).toEqual([]);
    expect(f.calls.at(-1)!.args).toEqual(["detach", f.mount()]);
    expect(existsSync(dirname(f.mount()))).toBe(false);
  },
);

it.each(["detach", "image-mutation"])("returns no report on %s failure", async (failure) => {
  const f = await fixture(failure);
  const { verifySignedDmg } = await signedApi("signed-dmg");
  await expect(
    verifySignedDmg({ image: f.image, teamId, stage: "candidate" }, { run: f.run }),
  ).rejects.toThrow();
  if (failure === "detach") expect(existsSync(dirname(f.mount()))).toBe(true);
});

it("requires explicit notarized evidence but never claims release qualification", async () => {
  const f = await fixture();
  const { verifySignedDmg } = await signedApi("signed-dmg");
  const report = await verifySignedDmg(
    { image: f.image, teamId, stage: "notarized" },
    { run: f.run },
  );
  expect(report).toMatchObject({ stage: "notarized", notarized: true, releaseReady: false });
  expect(
    f.calls.filter((call) => call.file === "/usr/sbin/spctl").map((call) => call.args),
  ).toEqual([
    ["--status"],
    [
      "--assess",
      "--type",
      "open",
      "--context",
      "context:primary-signature",
      "--verbose=4",
      f.image,
    ],
    ["--assess", "--type", "execute", "--verbose=4", join(f.mount(), "Shellbell.app")],
  ]);
  const firstRuntime = f.calls.findIndex((call) => call.file.endsWith("/Helpers/node"));
  expect(f.calls.slice(firstRuntime).some((call) => call.file === "/usr/sbin/spctl")).toBe(false);
});

it.each(["stapler", "disabled", "assessment", "unnotarized"])(
  "does not downgrade notarized stage on %s failure",
  async (failure) => {
    const f = await fixture(failure);
    const { verifySignedDmg } = await signedApi("signed-dmg");
    await expect(
      verifySignedDmg({ image: f.image, teamId, stage: "notarized" }, { run: f.run }),
    ).rejects.toThrow();
    expect(f.runtimeCalls).toEqual([]);
  },
);

it.each(["symlink", "writable", "empty", "oversized", "relative", "stage"])(
  "rejects %s input before commands",
  async (failure) => {
    const f = await fixture();
    let image = f.image;
    if (failure === "symlink") {
      image = join(f.root, "alias.dmg");
      symlinkSync(f.image, image);
    }
    if (failure === "writable") chmodSync(image, 0o666);
    if (failure === "empty") truncateSync(image, 0);
    if (failure === "oversized") truncateSync(image, 1024 ** 3 + 1);
    if (failure === "relative") image = "relative.dmg";
    const { verifySignedDmg } = await signedApi("signed-dmg");
    await expect(
      verifySignedDmg(
        { image, teamId, stage: failure === "stage" ? "auto" : "candidate" },
        { run: f.run },
      ),
    ).rejects.toThrow();
    expect(f.calls).toEqual([]);
  },
);
