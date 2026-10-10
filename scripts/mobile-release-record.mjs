import assert from "node:assert/strict";

function counter(value) {
  assert.match(value, /^[1-9][0-9]*$/, "Invalid candidate counter");
  assert.ok(Number.isSafeInteger(Number(value)), "Candidate counter exceeds safe range");
  return Number(value);
}

export function candidateTag(version, run, attempt) {
  assert.match(version, /^\d+\.\d+\.\d+$/, "Invalid marketing version");
  counter(run);
  counter(attempt);
  return `mobile-v${version}-beta.${run}.${attempt}`;
}

export function parseCandidateTag(tag) {
  const match = /^mobile-v(\d+\.\d+\.\d+)-beta\.(local\.)?([1-9][0-9]*)\.([1-9][0-9]*)$/.exec(tag);
  assert.ok(match, "Invalid candidate tag");
  const first = counter(match[3]);
  const second = counter(match[4]);
  const local = match[2] !== undefined;
  if (local)
    assert.ok(first <= 2_100_000_000 && second <= 2_100_000_000, "Invalid native build number");
  return { version: match[1], local, first, second };
}

export function preparedCandidateTag(version, run, currentAttempt, prepared) {
  counter(currentAttempt);
  assert.equal(typeof prepared, "string", "Use the candidate selected by prepare");
  const prefix = candidateTag(version, run, "1").slice(0, -1);
  assert.ok(prepared.startsWith(prefix), "Prepared candidate belongs to another source run");
  const attempt = prepared.slice(prefix.length);
  assert.ok(counter(attempt) <= counter(currentAttempt), "Prepared attempt has not run");
  return prepared;
}

export function validateReceipts(android, ios, version, source) {
  for (const [platform, receipt, destination] of [
    ["android", android, "Google Play internal"],
    ["ios", ios, "TestFlight internal"],
  ]) {
    assert.equal(receipt.schemaVersion, 1);
    assert.equal(receipt.platform, platform);
    assert.equal(receipt.version, version);
    assert.equal(receipt.sourceCommit, source);
    assert.equal(receipt.destination, destination, "Receipt must describe internal testing");
    assert.equal(receipt.storeAssignmentVerified, true, "Verify store assignment before tagging");
    assert.ok(
      Number.isSafeInteger(receipt.buildNumber) &&
        receipt.buildNumber > 0 &&
        receipt.buildNumber <= 2100000000,
      "Invalid native build number",
    );
    assert.match(receipt.artifactSha256, /^[a-f0-9]{64}$/);
  }
}

export function candidateRecord({ repository, source, version, tag, android, ios }) {
  assert.match(repository, /^[\w.-]+\/[\w.-]+$/, "Invalid repository");
  assert.match(source, /^[a-f0-9]{40}$/, "Invalid source commit");
  const candidate = parseCandidateTag(tag);
  assert.equal(candidate.version, version);
  validateReceipts(android, ios, version, source);
  if (candidate.local) {
    assert.equal(candidate.first, android.buildNumber, "Local tag must match Android receipt");
    assert.equal(candidate.second, ios.buildNumber, "Local tag must match iOS receipt");
  }
  return {
    tag_name: tag,
    target_commitish: source,
    name: candidate.local
      ? `Mobile ${version} local beta (Android ${candidate.first}, iOS ${candidate.second})`
      : `Mobile ${version} beta ${candidate.first}.${candidate.second}`,
    body: `Internal mobile candidate ${version}\n\nSource: ${source}\nAndroid: build ${android.buildNumber}, Google Play internal testing\niOS: build ${ios.buildNumber}, TestFlight internal testing\n\nBoth store assignments were verified. Physical delivery and device QA remain separate from store acceptance.\n\nAndroid SHA-256: ${android.artifactSha256}\niOS SHA-256: ${ios.artifactSha256}\n`,
    draft: false,
    prerelease: true,
  };
}

// This public metadata contains no credentials or private diagnostic paths.
// The website uses it to distinguish internal store delivery from public access.
export function candidateManifest(input) {
  candidateRecord(input);
  const { source, tag, version, android, ios } = input;
  return {
    schemaVersion: 1,
    component: "mobile",
    channel: "internal",
    sourceCommit: source,
    tag,
    version,
    platforms: Object.fromEntries(
      [android, ios].map(({ platform, buildNumber, artifactSha256, destination }) => [
        platform,
        { buildNumber, artifactSha256, destination, storeAssignmentVerified: true },
      ]),
    ),
  };
}

// A partial tagging failure may leave the ref behind. Resume only if the exact
// source and existing release metadata agree; never move or repurpose a tag.
export async function publishCandidate(input, github) {
  const record = candidateRecord(input);
  const base = `repos/${input.repository}`;
  let reference = await github("GET", `${base}/git/ref/tags/${input.tag}`);
  if (!reference) {
    reference = await github("POST", `${base}/git/refs`, {
      ref: `refs/tags/${input.tag}`,
      sha: input.source,
    });
  }
  assert.equal(reference.object?.type, "commit", "Candidate must reference a commit directly");
  assert.equal(reference.object.sha, input.source, "Existing candidate references another source");
  let release = await github("GET", `${base}/releases/tags/${input.tag}`);
  if (!release) release = await github("POST", `${base}/releases`, record);
  for (const field of ["tag_name", "name", "draft", "prerelease"]) {
    assert.equal(release[field], record[field], `Existing release differs: ${field}`);
  }
  assert.equal(
    release.body?.replaceAll("\r\n", "\n").trimEnd(),
    record.body.trimEnd(),
    "Existing release describes different delivered artifacts",
  );
  return release.html_url;
}
