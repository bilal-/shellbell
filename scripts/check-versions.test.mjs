import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, test } from "node:test";
import { fileURLToPath } from "node:url";
import { checkMajorReleasePlan, checkVersions } from "./check-versions.mjs";

const source = new URL("../", import.meta.url);
const paths = [
  "apps/agent/package.json",
  "apps/mobile/package.json",
  "apps/mobile/app.json",
  "packages/relay-core/package.json",
  "apps/relay/package.json",
  "apps/relay-node/package.json",
  "packages/protocol/package.json",
  ".changeset/config.json",
  "release-policy.json",
];
const roots = [];
function edit(root, path, update) {
  const target = join(root, path);
  const data = JSON.parse(readFileSync(target, "utf8"));
  update(data);
  writeFileSync(target, JSON.stringify(data));
}
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "shellbell-versions-"));
  roots.push(root);
  for (const path of paths) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), readFileSync(new URL(path, source)));
  }
  // Deliberately unrelated release numbers: wire compatibility does not depend
  // on the computer, relay and mobile marketing versions being equal.
  for (const [path, version] of [
    ["apps/agent/package.json", "0.7.2"],
    ["apps/mobile/package.json", "0.3.4"],
    ["packages/relay-core/package.json", "0.6.1"],
    ["apps/relay/package.json", "0.6.1"],
    ["apps/relay-node/package.json", "0.6.1"],
    ["packages/protocol/package.json", "0.9.0"],
  ])
    edit(root, path, (pkg) => {
      pkg.version = version;
    });
  edit(root, "apps/mobile/app.json", (config) => {
    config.expo.version = "0.3.4";
  });
  return root;
}
function cliFixture() {
  const root = fixture();
  for (const path of [
    "package.json",
    "pnpm-workspace.yaml",
    "scripts/check-versions.mjs",
    "scripts/sync-mobile-version.mjs",
  ]) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), readFileSync(new URL(path, source)));
  }
  const tools = join(root, "node_modules/@changesets");
  mkdirSync(tools, { recursive: true });
  symlinkSync(
    fileURLToPath(new URL("node_modules/@changesets/cli", source)),
    join(tools, "cli"),
    "dir",
  );
  return root;
}
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true });
});

test("accepts independent release lines and their exact component tags", () => {
  const root = fixture();
  const components = checkVersions(root);
  assert.equal(components.computer.version, "0.7.2");
  for (const args of [
    ["--computer-tag", "shellbell@0.7.2"],
    ["--computer-candidate-tag", "computer-v0.7.2-beta.5"],
    ["--mobile-tag", "mobile-v0.3.4"],
    ["--relay-tag", "relay-v0.6.1"],
  ])
    assert.doesNotThrow(() => checkVersions(root, args));
});

test("accepts the owner-approved mobile 1.0 launch and its later compatible releases", () => {
  const root = fixture();
  edit(root, "apps/mobile/package.json", (pkg) => {
    pkg.version = "1.0.0";
  });
  edit(root, "apps/mobile/app.json", (config) => {
    config.expo.version = "1.0.0";
  });
  assert.doesNotThrow(() => checkVersions(root, ["--mobile-tag", "mobile-v1.0.0"]));
  assert.doesNotThrow(() =>
    checkMajorReleasePlan(root, {
      releases: [
        { name: "@shellbell/mobile", type: "major", newVersion: "1.0.0" },
        { name: "@shellbell/mobile", type: "minor", newVersion: "1.8.0" },
        { name: "@shellbell/mobile", type: "patch", newVersion: "1.8.1" },
      ],
    }),
  );
});
test("accepts mobile beta candidate tags only for the prepared marketing version", () => {
  const root = fixture();
  assert.doesNotThrow(() =>
    checkVersions(root, ["--mobile-candidate-tag", "mobile-v0.3.4-beta.12.2"]),
  );
  for (const tag of [
    "mobile-v0.3.3-beta.12.2",
    "mobile-v0.3.4",
    "mobile-v0.3.4-beta.0.1",
    "mobile-v0.3.4-beta.01.1",
    "mobile-v0.3.4-beta.12.0",
    "mobile-v0.3.4-beta.12.01",
    "mobile-v0.3.4-beta.12.2-extra",
  ])
    assert.throws(() => checkVersions(root, ["--mobile-candidate-tag", tag]));
});

test("blocks mobile 2.0 in source metadata until the owner approves the major", () => {
  const root = fixture();
  edit(root, "apps/mobile/package.json", (pkg) => {
    pkg.version = "2.0.0";
  });
  edit(root, "apps/mobile/app.json", (config) => {
    config.expo.version = "2.0.0";
  });
  assert.throws(() => checkVersions(root), /discuss the major upgrade.*explicit owner approval/);
});

for (const [name, version] of [
  ["@shellbell/mobile", "2.0.0"],
  ["shellbell", "1.0.0"],
  ["@shellbell/relay-core", "1.0.0"],
  ["@shellbell/relay", "1.0.0"],
  ["@shellbell/relay-node", "1.0.0"],
  ["@shellbell/protocol", "1.0.0"],
])
  test(`blocks an unapproved planned major before version preparation: ${name}@${version}`, () => {
    assert.throws(
      () =>
        checkMajorReleasePlan(fixture(), {
          releases: [{ name, type: "major", newVersion: version }],
        }),
      /explicit owner approval/,
    );
  });

test("checks the resulting major even when a dependency plan describes a patch bump", () => {
  assert.throws(
    () =>
      checkMajorReleasePlan(fixture(), {
        releases: [{ name: "@shellbell/mobile", type: "patch", newVersion: "2.0.1" }],
      }),
    /explicit owner approval/,
  );
});

test("fails closed for missing, invalid or unknown major approvals", () => {
  const root = fixture();
  edit(root, "release-policy.json", (policy) => {
    delete policy.approvedMajors["@shellbell/mobile"];
  });
  assert.throws(() => checkVersions(root), /exactly the release packages/);
  for (const major of [-1, "1", null, 1.5]) {
    edit(root, "release-policy.json", (policy) => {
      policy.approvedMajors["@shellbell/mobile"] = major;
    });
    assert.throws(() => checkVersions(root), /invalid approved major ceiling/);
  }
  assert.throws(
    () =>
      checkMajorReleasePlan(fixture(), {
        releases: [{ name: "unknown-package", type: "major", newVersion: "1.0.0" }],
      }),
    /declare an owner-approved release line/,
  );
});

test("keeps major approval aligned across both relay adapters and the core", () => {
  const root = fixture();
  edit(root, "release-policy.json", (policy) => {
    policy.approvedMajors["@shellbell/relay"] = 1;
  });
  assert.throws(() => checkVersions(root), /share the core's approved major ceiling/);
});

test("version preparation rejects a real unapproved Changeset before mutating files", () => {
  const root = cliFixture();
  edit(root, "apps/mobile/package.json", (pkg) => {
    pkg.version = "1.0.0";
  });
  edit(root, "apps/mobile/app.json", (config) => {
    config.expo.version = "1.0.0";
  });
  const proposal = join(root, ".changeset/unapproved.md");
  writeFileSync(
    proposal,
    '---\n"@shellbell/mobile": major\n---\nPropose a future major upgrade.\n',
  );
  const tracked = [...paths.map((path) => join(root, path)), proposal];
  const before = tracked.map((path) => readFileSync(path, "utf8"));
  const result = spawnSync("pnpm", ["version:packages"], {
    cwd: root,
    // This fixture has a sparse tools directory, not a dependency installation.
    // Keep pnpm's automatic installer disabled within the fixture only.
    env: { ...process.env, pnpm_config_verify_deps_before_run: "warn" },
    encoding: "utf8",
    timeout: 30000,
    maxBuffer: 1024 * 1024,
  });
  assert.equal(result.status, 1, result.stderr);
  assert.match(result.stderr, /@shellbell\/mobile@2\.0\.0.*explicit owner approval/);
  assert.deepEqual(
    tracked.map((path) => readFileSync(path, "utf8")),
    before,
  );
});

test("the actual version check accepts an empty release plan after preparation", () => {
  const result = spawnSync("pnpm", ["check:versions"], {
    cwd: cliFixture(),
    env: { ...process.env, pnpm_config_verify_deps_before_run: "warn" },
    encoding: "utf8",
    timeout: 30000,
    maxBuffer: 1024 * 1024,
  });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Queued release majors match/);
});

for (const args of [
  ["--computer-tag", "shellbell-v0.7.2"],
  ["--computer-tag", "shellbell@0.3.4"],
  ["--mobile-tag", "mobile-v0.7.2"],
  ["--relay-tag", "relay-v0.6.0"],
  ["--relay-tag", "relay-v0.6.1-beta.1"],
  ["--computer-tag"],
  ["--unknown", "0.7.2"],
  ["--relay-tag", "relay-v0.6.1", "--mobile-tag", "mobile-v0.3.4"],
])
  test(`rejects a mismatched or ambiguous tag: ${args.join(" ")}`, () => {
    assert.throws(() => checkVersions(fixture(), args));
  });

for (const version of ["1.2", "01.2.3", "1.2.3-beta.1", "1.2.3+build.9", "1.2.3junk"]) {
  test(`rejects a noncanonical native marketing version: ${version}`, () => {
    const root = fixture();
    edit(root, "apps/agent/package.json", (pkg) => {
      pkg.version = version;
    });
    assert.throws(() => checkVersions(root), /numeric X.Y.Z/);
  });
}

for (const [path, update, message] of [
  [
    "apps/relay/package.json",
    (pkg) => {
      pkg.version = "0.6.2";
    },
    /relay release versions/,
  ],
  [
    "apps/relay-node/package.json",
    (pkg) => {
      pkg.version = "0.6.2";
    },
    /relay release versions/,
  ],
  [
    "apps/mobile/app.json",
    (config) => {
      config.expo.version = "0.3.3";
    },
    /static Expo version/,
  ],
  [
    "apps/agent/package.json",
    (pkg) => {
      pkg.private = true;
    },
    /public npm package/,
  ],
  [
    "apps/mobile/package.json",
    (pkg) => {
      pkg.private = false;
    },
    /must stay private/,
  ],
  [
    "apps/agent/package.json",
    (pkg) => {
      pkg.name = "wrong-package";
    },
    /package identity/,
  ],
  [
    ".changeset/config.json",
    (config) => {
      config.fixed[0].pop();
    },
    /both relay adapters/,
  ],
  [
    ".changeset/config.json",
    (config) => {
      config.privatePackages.tag = true;
    },
    /without publishing or tagging/,
  ],
])
  test(`rejects release metadata drift in ${path}: ${message.source}`, () => {
    const root = fixture();
    edit(root, path, update);
    assert.throws(() => checkVersions(root), message);
  });
