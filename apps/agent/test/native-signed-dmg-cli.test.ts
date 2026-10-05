import { execFileSync } from "node:child_process";
import { resolve } from "node:path";
import { expect, it } from "vitest";
import { signedApi, teamId } from "./native-signed-fixture.js";

const buildArgs = [
  "--app",
  "/tmp/source.app",
  "--output",
  "/tmp/output",
  "--identity-sha1",
  "a".repeat(40),
  "--team-id",
  teamId,
];
const verifyArgs = [
  "--image",
  "/tmp/source.dmg",
  "--team-id",
  teamId,
  "--stage",
  "candidate",
  "--report",
  "/tmp/report.json",
];

it("parses only the complete explicit build and verification modes", async () => {
  const { parseDmgArgs } = await signedApi("signed-dmg");
  expect(parseDmgArgs(buildArgs, "build")).toEqual({
    app: "/tmp/source.app",
    output: "/tmp/output",
    identitySha1: "a".repeat(40),
    teamId,
  });
  expect(parseDmgArgs(verifyArgs, "verify")).toEqual({
    image: "/tmp/source.dmg",
    teamId,
    stage: "candidate",
    report: "/tmp/report.json",
  });
});

it.each([
  ["build", []],
  ["verify", verifyArgs.slice(0, -2)],
  ["build", [...buildArgs, "--team-id", teamId]],
  ["build", [...buildArgs, "--deep", "true"]],
  ["build", buildArgs.map((value) => (value === "/tmp/source.app" ? "relative.app" : value))],
  ["build", buildArgs.map((value) => (value === "a".repeat(40) ? "-" : value))],
  ["verify", verifyArgs.map((value) => (value === teamId ? "invalid" : value))],
  ["verify", verifyArgs.map((value) => (value === "candidate" ? "auto" : value))],
  ["verify", verifyArgs.map((value) => (value === "/tmp/report.json" ? "relative.json" : value))],
  ["verify", [...verifyArgs, "--notarize", "true"]],
  ["unknown", buildArgs],
] as const)("refuses malformed %s arguments", async (mode, args) => {
  const { parseDmgArgs } = await signedApi("signed-dmg");
  expect(() => parseDmgArgs(args, mode)).toThrow();
});

it.each(["build", "verify"])(
  "runs the %s CLI help without signing, mounting or account operations",
  (mode) => {
    const script = resolve(`../macos/scripts/${mode}-signed-dmg.mjs`);
    expect(
      execFileSync(process.execPath, [script, "--help"], { encoding: "utf8", timeout: 5000 }),
    ).toContain(`native:${mode}-signed-dmg`);
    try {
      execFileSync(process.execPath, [script, "--unknown"], {
        encoding: "utf8",
        timeout: 5000,
        stdio: "pipe",
      });
      throw Error("unexpected success");
    } catch (error) {
      expect(error).toMatchObject({ status: 1 });
      expect(String((error as { stderr: unknown }).stderr)).toContain("dmg-arguments");
    }
  },
);
