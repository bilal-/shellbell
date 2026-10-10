import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { appendFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { checkVersions } from "./check-versions.mjs";
import {
  candidateManifest,
  candidateTag,
  parseCandidateTag,
  preparedCandidateTag,
  publishCandidate,
} from "./mobile-release-record.mjs";

export { candidateTag, validateReceipts } from "./mobile-release-record.mjs";

export function releaseSource(eventName, env) {
  assert.equal(env.GITHUB_REF, "refs/heads/main", "Internal releases run from main only");
  assert.equal(eventName, "workflow_dispatch", "Internal releases require an explicit request");
  const source = env.GITHUB_SHA;
  assert.match(source, /^[a-f0-9]{40}$/, "Invalid source commit");
  return source;
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
  parseCandidateTag(previous);
  const changed = command(
    "git",
    ["diff", "--name-only", previous, source, "--", ...relevantPaths],
    cwd,
  );
  return { baseline: previous, changed: changed !== "" };
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
  const tag =
    operation === "prepare"
      ? candidateTag(version, env.GITHUB_RUN_NUMBER, env.GITHUB_RUN_ATTEMPT)
      : preparedCandidateTag(
          version,
          env.GITHUB_RUN_NUMBER,
          env.GITHUB_RUN_ATTEMPT,
          env.SHELLBELL_CANDIDATE_TAG,
        );
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
    const input = { repository: env.GITHUB_REPOSITORY, source, version, tag, android, ios };
    const url = await publishCandidate(input, async (method, path, payload) => {
      const result = spawnSync(
        "gh",
        ["api", path, "--method", method, ...(payload ? ["--input", "-"] : [])],
        { input: payload ? JSON.stringify(payload) : undefined, encoding: "utf8" },
      );
      if (method === "GET" && result.status !== 0 && /HTTP 404/.test(result.stderr)) return null;
      assert.equal(result.status, 0, `GitHub ${method} failed: ${result.stderr}`);
      return JSON.parse(result.stdout);
    });
    const directory = mkdtempSync(join(tmpdir(), "shellbell-release-manifest-"));
    try {
      const name = "mobile-release.json";
      const path = join(directory, name);
      const contents = `${JSON.stringify(candidateManifest(input), null, 2)}\n`;
      const assets = JSON.parse(
        command("gh", [
          "release",
          "view",
          tag,
          "--repo",
          env.GITHUB_REPOSITORY,
          "--json",
          "assets",
        ]),
      ).assets;
      if (assets.some((asset) => asset.name === name)) {
        command("gh", [
          "release",
          "download",
          tag,
          "--repo",
          env.GITHUB_REPOSITORY,
          "--pattern",
          name,
          "--dir",
          directory,
        ]);
        assert.equal(
          readFileSync(path, "utf8"),
          contents,
          "Existing release manifest describes another delivery",
        );
      } else {
        writeFileSync(path, contents);
        command("gh", ["release", "upload", tag, path, "--repo", env.GITHUB_REPOSITORY]);
      }
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
    console.log(url);
  } else throw new Error("Use prepare or tag");
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href)
  await main();
