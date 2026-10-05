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
import {
  candidateManifest,
  candidateRecord,
  preparedCandidateTag,
  publishCandidate,
} from "./mobile-release-record.mjs";

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
  destination: platform === "android" ? "Google Play internal" : "TestFlight internal",
});

test("tag-only retries keep the original prepared candidate", () => {
  const tag = "mobile-v1.0.0-beta.12.1";
  assert.equal(preparedCandidateTag("1.0.0", "12", "2", tag), tag);
  for (const other of [
    undefined,
    "mobile-v1.0.0-beta.13.1",
    "mobile-v1.0.0-beta.12.3",
    "mobile-v2.0.0-beta.12.1",
  ]) {
    assert.throws(() => preparedCandidateTag("1.0.0", "12", "2", other));
  }
});

const delivery = () => ({
  repository: "example/shellbell",
  source: sha,
  version: "1.0.0",
  tag: "mobile-v1.0.0-beta.12.1",
  android: receipt("android"),
  ios: receipt("ios"),
});
test("public manifest describes internal delivery without copying private receipt fields", () => {
  const input = delivery();
  input.android.privatePath = "/private/signing.json";
  input.ios.credentials = "not public";
  const manifest = candidateManifest(input);
  assert.equal(manifest.sourceCommit, sha);
  assert.equal(manifest.channel, "internal");
  assert.equal(manifest.platforms.android.destination, "Google Play internal");
  assert.equal(manifest.platforms.ios.storeAssignmentVerified, true);
  assert.equal(JSON.stringify(manifest).includes("private"), false);
  assert.equal(JSON.stringify(manifest).includes("credentials"), false);
});

function fakeGithub(initial = {}, failRelease = false) {
  const state = { ...initial };
  const calls = [];
  return {
    state,
    calls,
    request: async (method, path, payload) => {
      calls.push({ method, path, payload });
      if (path.includes("/git/ref/tags/")) return state.reference ?? null;
      if (path.endsWith("/git/refs")) {
        state.reference = { object: { sha: payload.sha, type: "commit" } };
        return state.reference;
      }
      if (path.includes("/releases/tags/")) return state.release ?? null;
      assert.ok(path.endsWith("/releases"));
      if (failRelease) throw new Error("Temporary release API failure");
      state.release = {
        ...payload,
        html_url: "https://github.com/example/shellbell/releases/tag/mobile-v1.0.0-beta.12.1",
      };
      return state.release;
    },
  };
}

test("publishes both verified store assignments and safely resumes an existing release", async () => {
  const input = delivery();
  const github = fakeGithub();
  const url = await publishCandidate(input, github.request);
  assert.match(url, /mobile-v1.0.0-beta.12.1$/);
  const record = candidateRecord(input);
  assert.equal(github.state.release.body, record.body);
  assert.equal(github.state.reference.object.sha, sha);
  const writes = github.calls.filter((call) => call.method === "POST").length;
  assert.equal(await publishCandidate(input, github.request), url);
  assert.equal(github.calls.filter((call) => call.method === "POST").length, writes);
});

test("resumes after ref creation without moving the ref or rebuilding stores", async () => {
  const input = delivery();
  const failed = fakeGithub({}, true);
  await assert.rejects(publishCandidate(input, failed.request), /Temporary release API failure/);
  const resumed = fakeGithub(failed.state);
  await publishCandidate(input, resumed.request);
  assert.equal(resumed.calls.filter((call) => call.path.endsWith("/git/refs")).length, 0);
  assert.equal(resumed.calls.filter((call) => call.method === "POST").length, 1);
});

test("refuses existing refs and metadata belonging to different delivered artifacts", async () => {
  const input = delivery();
  const wrongRef = fakeGithub({ reference: { object: { sha: "b".repeat(40), type: "commit" } } });
  await assert.rejects(publishCandidate(input, wrongRef.request), /another source/);
  assert.equal(wrongRef.calls.filter((call) => call.method === "POST").length, 0);
  const wrongMetadata = fakeGithub({
    reference: { object: { sha, type: "commit" } },
    release: {
      ...candidateRecord(input),
      body: "Other receipt",
      html_url: "https://github.com/example/shellbell",
    },
  });
  await assert.rejects(
    publishCandidate(input, wrongMetadata.request),
    /different delivered artifacts/,
  );
  assert.equal(wrongMetadata.calls.filter((call) => call.method === "POST").length, 0);
});

test("refuses a production or unassigned receipt before creating any GitHub metadata", async () => {
  const input = delivery();
  const github = fakeGithub();
  await assert.rejects(
    publishCandidate(
      { ...input, android: { ...input.android, destination: "production" } },
      github.request,
    ),
    /internal testing/,
  );
  await assert.rejects(
    publishCandidate(
      { ...input, ios: { ...input.ios, storeAssignmentVerified: false } },
      github.request,
    ),
    /assignment/,
  );
  assert.equal(github.calls.length, 0);
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
