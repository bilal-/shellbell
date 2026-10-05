import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  candidateTag,
  mobileReleaseChanges,
  releaseSource,
  validateReceipts,
} from "./mobile-release.mjs";

const sha = "a".repeat(40);
const env = {
  GITHUB_REF: "refs/heads/main",
  GITHUB_SHA: sha,
  GITHUB_REPOSITORY: "example/shellbell",
};
test("uses the requested exact main source commit", () => {
  assert.equal(releaseSource("workflow_dispatch", env), sha);
});
for (const name of ["workflow_run", "push", "pull_request", "schedule"]) {
  test(`refuses automatic release event: ${name}`, () =>
    assert.throws(() => releaseSource(name, env)));
}
test("refuses manual releases from a different branch", () =>
  assert.throws(() =>
    releaseSource("workflow_dispatch", { ...env, GITHUB_REF: "refs/heads/topic" }),
  ));
test("candidate attempts get separate immutable tags", () => {
  assert.equal(candidateTag("1.0.0", "12", "2"), "mobile-v1.0.0-beta.12.2");
  for (const number of ["0", "01", "-1", "1;echo"])
    assert.throws(() => candidateTag("1.0.0", number, "1"));
});
test("pending mobile changes survive intervening docs commits and merge commits", () => {
  const root = mkdtempSync(join(tmpdir(), "shellbell-mobile-delivery-"));
  const git = (...args) =>
    execFileSync("git", args, {
      cwd: root,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
  const commit = (path, content) => {
    mkdirSync(join(root, path, ".."), { recursive: true });
    writeFileSync(join(root, path), content);
    git("add", path);
    git("commit", "-m", path);
    return git("rev-parse", "HEAD");
  };
  try {
    git("init", "-b", "main");
    git("config", "user.name", "Fixture");
    git("config", "user.email", "fixture@example.test");
    commit("apps/mobile/package.json", "initial");
    let source = commit("docs/README.md", "first docs");
    assert.deepEqual(mobileReleaseChanges(source, root), { baseline: null, changed: true });
    const baseline = "mobile-v1.0.0-beta.1.1";
    git("tag", baseline);
    source = commit("docs/README.md", "second docs");
    assert.deepEqual(mobileReleaseChanges(source, root), { baseline, changed: false });
    commit("apps/mobile/package.json", "mobile changes");
    source = commit("docs/README.md", "third docs");
    assert.deepEqual(mobileReleaseChanges(source, root), { baseline, changed: true });
    git("tag", "mobile-v1.0.0-beta.2.1");
    git("switch", "-c", "feature");
    commit("packages/protocol/package.json", "protocol changes");
    git("switch", "main");
    git("merge", "--no-ff", "feature", "-m", "Merge protocol change");
    assert.equal(mobileReleaseChanges(git("rev-parse", "HEAD"), root).changed, true);
  } finally {
    rmSync(root, { recursive: true });
  }
});
const receipt = (platform) => ({
  schemaVersion: 1,
  platform,
  version: "1.0.0",
  buildNumber: 4,
  sourceCommit: sha,
  artifactSha256: "c".repeat(64),
  storeAssignmentVerified: true,
});
test("both matching store assignments are required before tagging", () => {
  assert.doesNotThrow(() =>
    validateReceipts(receipt("android"), { ...receipt("ios"), buildNumber: 2 }, "1.0.0", sha),
  );
  for (const update of [
    { storeAssignmentVerified: false },
    { sourceCommit: "b".repeat(40) },
    { version: "0.1.0" },
    { buildNumber: 0 },
    { artifactSha256: "missing" },
  ])
    assert.throws(() =>
      validateReceipts(receipt("android"), { ...receipt("ios"), ...update }, "1.0.0", sha),
    );
});
