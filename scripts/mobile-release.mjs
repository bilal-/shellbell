import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { appendFileSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { checkVersions } from "./check-versions.mjs";

export function releaseSource(eventName, env) {
  assert.equal(env.GITHUB_REF, "refs/heads/main", "Internal releases run from main only");
  assert.equal(eventName, "workflow_dispatch", "Internal releases require an explicit request");
  const source = env.GITHUB_SHA;
  assert.match(source, /^[a-f0-9]{40}$/, "Invalid source commit");
  return source;
}

export function candidateTag(version, run, attempt) {
  for (const number of [run, attempt])
    assert.match(number, /^[1-9][0-9]*$/, "Invalid candidate counter");
  return `mobile-v${version}-beta.${run}.${attempt}`;
}

function command(name, args, cwd) {
  const result = spawnSync(name, args, { encoding: "utf8", cwd });
  assert.equal(result.status, 0, `${name} failed: ${result.stderr}`);
  return result.stdout.trim();
}
const relevantPaths = [
  "apps/mobile",
  "packages/protocol",
  "package.json",
  "pnpm-lock.yaml",
  "pnpm-workspace.yaml",
  "Gemfile",
  "Gemfile.lock",
  "release-policy.json",
  ".github/workflows/mobile-internal.yml",
  "scripts/mobile-release*",
];

export function mobileReleaseChanges(source, cwd) {
  const previous = command(
    "git",
    ["describe", "--tags", "--match", "mobile-v*-beta.*", "--abbrev=0", "--always", source],
    cwd,
  );
  if (!previous.startsWith("mobile-v")) return { baseline: null, changed: true };
  assert.match(previous, /^mobile-v\d+\.\d+\.\d+-beta\.[1-9][0-9]*\.[1-9][0-9]*$/);
  const changed = command(
    "git",
    ["diff", "--name-only", previous, source, "--", ...relevantPaths],
    cwd,
  );
  return { baseline: previous, changed: changed !== "" };
}

export function validateReceipts(android, ios, version, source) {
  for (const [platform, receipt] of [
    ["android", android],
    ["ios", ios],
  ]) {
    assert.equal(receipt.schemaVersion, 1);
    assert.equal(receipt.platform, platform);
    assert.equal(receipt.version, version);
    assert.equal(receipt.sourceCommit, source);
    assert.equal(
      receipt.storeAssignmentVerified,
      true,
      "Store delivery must be verified before tagging",
    );
    assert.ok(
      Number.isSafeInteger(receipt.buildNumber) &&
        receipt.buildNumber > 0 &&
        receipt.buildNumber <= 2100000000,
    );
    assert.match(receipt.artifactSha256, /^[a-f0-9]{64}$/);
  }
}

async function passedCI(repo, source, token) {
  const response = await fetch(
    `https://api.github.com/repos/${repo}/actions/workflows/ci.yml/runs?head_sha=${source}&event=push&per_page=100`,
    { headers: { Authorization: `Bearer ${token}`, Accept: "application/vnd.github+json" } },
  );
  assert.ok(response.ok, "Cannot verify source CI");
  const result = await response.json();
  assert.ok(
    result.workflow_runs.some(
      (run) =>
        run.head_branch === "main" && run.head_sha === source && run.conclusion === "success",
    ),
    "This source revision must pass CI before internal release",
  );
}

async function main() {
  const [operation, ...args] = process.argv.slice(2);
  const env = process.env;
  assert.equal(env.GITHUB_ACTIONS, "true", "Use this entry point on GitHub Actions");
  const source = releaseSource(env.GITHUB_EVENT_NAME, env);
  assert.equal(
    command("git", ["rev-parse", "HEAD"]),
    source,
    "Release checkout must match tested source",
  );
  const root = process.cwd();
  const version = checkVersions(root).mobile.version;
  const tag = candidateTag(version, env.GITHUB_RUN_NUMBER, env.GITHUB_RUN_ATTEMPT);
  checkVersions(root, ["--mobile-candidate-tag", tag]);
  if (operation === "prepare") {
    await passedCI(env.GITHUB_REPOSITORY, source, env.GH_TOKEN);
    const ahead = command("git", [
      "diff",
      "--name-only",
      source,
      "origin/main",
      "--",
      ...relevantPaths,
    ]);
    const { baseline, changed } = mobileReleaseChanges(source, root);
    const release = ahead === "";
    console.log(
      ahead !== ""
        ? "Skip superseded mobile source; wait for the newer revision's passing CI"
        : `Mobile changes since ${baseline || "initial delivery"}: ${changed}`,
    );
    appendFileSync(
      env.GITHUB_OUTPUT,
      `release=${release}\nsource_sha=${source}\nversion=${version}\ncandidate_tag=${tag}\n`,
    );
  } else if (operation === "tag") {
    assert.equal(args.length, 2, "Provide both verified store receipts");
    const [android, ios] = args.map((path) => JSON.parse(readFileSync(path, "utf8")));
    validateReceipts(android, ios, version, source);
    const notes = `Internal mobile candidate ${version}\n\nSource: ${source}\nAndroid: build ${android.buildNumber}, Google Play internal testing\niOS: build ${ios.buildNumber}, TestFlight internal testing\n\nBoth store assignments were verified. Physical delivery and device QA remain separate from store acceptance.\n\nAndroid SHA-256: ${android.artifactSha256}\niOS SHA-256: ${ios.artifactSha256}\n`;
    // Atomically create the exact source tag; an existing tag is never reused.
    const reference = spawnSync(
      "gh",
      ["api", `repos/${env.GITHUB_REPOSITORY}/git/refs`, "--method", "POST", "--input", "-"],
      { input: JSON.stringify({ ref: `refs/tags/${tag}`, sha: source }), encoding: "utf8" },
    );
    assert.equal(reference.status, 0, `Candidate tag creation failed: ${reference.stderr}`);
    // Reruns reserve new store counters and use a fresh attempt suffix.
    const result = spawnSync(
      "gh",
      [
        "release",
        "create",
        tag,
        "--verify-tag",
        "--prerelease",
        "--title",
        `${version} beta ${env.GITHUB_RUN_NUMBER}.${env.GITHUB_RUN_ATTEMPT}`,
        "--notes-file",
        "-",
      ],
      { input: notes, encoding: "utf8" },
    );
    assert.equal(result.status, 0, `Candidate tagging failed: ${result.stderr}`);
    console.log(result.stdout.trim());
  } else throw new Error("Use prepare or tag");
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href)
  await main();
