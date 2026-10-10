import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseCandidateTag } from "./mobile-release-record.mjs";

const versionPattern = /^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$/;
function approvalPolicy(root) {
  const policy = JSON.parse(readFileSync(resolve(root, "release-policy.json"), "utf8"));
  assert.equal(policy.schemaVersion, 1, "unknown major approval policy format");
  assert.ok(
    policy.approvedMajors &&
      typeof policy.approvedMajors === "object" &&
      !Array.isArray(policy.approvedMajors),
    "record the owner's approved major ceilings",
  );
  for (const [name, major] of Object.entries(policy.approvedMajors)) {
    assert.ok(Number.isSafeInteger(major) && major >= 0, `${name}: invalid approved major ceiling`);
  }
  return policy.approvedMajors;
}
function checkApprovedMajor(approvedMajors, name, version) {
  assert.ok(Object.hasOwn(approvedMajors, name), `${name}: declare an owner-approved release line`);
  assert.match(version, versionPattern, `${name}: use a numeric X.Y.Z component version`);
  assert.ok(
    Number(version.split(".")[0]) <= approvedMajors[name],
    `${name}@${version}: discuss the major upgrade and obtain explicit owner approval before changing the approved major ceiling`,
  );
}
export function checkMajorReleasePlan(root, plan) {
  const approvedMajors = approvalPolicy(root);
  assert.ok(Array.isArray(plan.releases), "invalid Changesets release plan");
  for (const release of plan.releases) {
    checkApprovedMajor(approvedMajors, release.name, release.newVersion);
  }
}

export function checkVersions(root, args = []) {
  const json = (path) => JSON.parse(readFileSync(resolve(root, path), "utf8"));
  const components = {
    computer: json("apps/agent/package.json"),
    mobile: json("apps/mobile/package.json"),
    core: json("packages/relay-core/package.json"),
    cloudflare: json("apps/relay/package.json"),
    node: json("apps/relay-node/package.json"),
    protocol: json("packages/protocol/package.json"),
  };
  const names = {
    computer: "shellbell",
    mobile: "@shellbell/mobile",
    core: "@shellbell/relay-core",
    cloudflare: "@shellbell/relay",
    node: "@shellbell/relay-node",
    protocol: "@shellbell/protocol",
  };
  const approvedMajors = approvalPolicy(root);
  assert.deepEqual(
    Object.keys(approvedMajors).sort(),
    Object.values(names).sort(),
    "record approved major ceilings for exactly the release packages",
  );
  for (const [name, pkg] of Object.entries(components)) {
    assert.equal(pkg.name, names[name], `${name}: release package identity must agree`);
    checkApprovedMajor(approvedMajors, pkg.name, pkg.version);
  }
  assert.notEqual(components.computer.private, true, "the computer CLI is the public npm package");
  for (const name of ["cloudflare", "node"]) {
    assert.equal(
      components[name].version,
      components.core.version,
      "relay release versions must agree",
    );
    assert.equal(
      approvedMajors[components[name].name],
      approvedMajors[components.core.name],
      "relay adapters must share the core's approved major ceiling",
    );
  }
  assert.equal(
    json("apps/mobile/app.json").expo.version,
    components.mobile.version,
    "the static Expo version must match the mobile package version",
  );
  for (const name of ["mobile", "core", "cloudflare", "node", "protocol"]) {
    assert.equal(components[name].private, true, `${name}: internal packages must stay private`);
  }
  const changesets = json(".changeset/config.json");
  const relayNames = ["core", "cloudflare", "node"].map((name) => components[name].name).sort();
  assert.equal(changesets.fixed.length, 1, "configure one fixed relay release group");
  assert.deepEqual(
    [...changesets.fixed[0]].sort(),
    relayNames,
    "include both relay adapters and the core",
  );
  assert.deepEqual(
    changesets.privatePackages,
    { version: true, tag: false },
    "version internal packages without publishing or tagging them through Changesets",
  );
  if (args.length) {
    const tags = {
      "--computer-tag": `shellbell@${components.computer.version}`,
      "--relay-tag": `relay-v${components.core.version}`,
      "--mobile-tag": `mobile-v${components.mobile.version}`,
    };
    assert.equal(args.length, 2, "supply one component or candidate tag value");
    if (args[0] === "--computer-candidate-tag") {
      assert.match(
        args[1],
        new RegExp(
          `^computer-v${components.computer.version.replaceAll(".", "\\.")}-beta\\.[1-9][0-9]*$`,
        ),
        "computer candidate must match source version and reserved native build",
      );
      return components;
    }
    if (args[0] === "--mobile-candidate-tag") {
      assert.equal(
        parseCandidateTag(args[1]).version,
        components.mobile.version,
        "candidate tag must match the source mobile version",
      );
      return components;
    }
    assert.ok(Object.hasOwn(tags, args[0]), "unknown component tag option");
    assert.equal(args[1], tags[args[0]], "component tag must match the checked-out release");
  }
  return components;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const root = fileURLToPath(new URL("../", import.meta.url));
  const components = checkVersions(root, process.argv.slice(2));
  // Use the pinned CLI's public planning modules. Unlike its status command,
  // this computes the full pending plan without requiring a base Git branch or
  // triggering pnpm dependency installation.
  const require = createRequire(join(root, "package.json"));
  const cli = createRequire(require.resolve("@changesets/cli/package.json"));
  const [packagesApi, configApi, changesetsApi, preApi, planApi] = await Promise.all(
    [
      "@manypkg/get-packages",
      "@changesets/config",
      "@changesets/read",
      "@changesets/pre",
      "@changesets/assemble-release-plan",
    ].map((name) => import(pathToFileURL(cli.resolve(name)).href)),
  );
  const packages = await packagesApi.getPackages(root);
  const [configuration, changesets, preState] = await Promise.all([
    configApi.readConfig(packages.rootDir, packages),
    changesetsApi.readChangesets(packages.rootDir),
    preApi.readPreState(packages.rootDir),
  ]);
  assert.equal(
    configuration.errors,
    undefined,
    `Invalid Changesets configuration: ${configuration.errors?.join("; ")}`,
  );
  for (const warning of configuration.warnings) console.warn(warning);
  checkMajorReleasePlan(
    root,
    planApi.assembleReleasePlan(changesets, packages, configuration.config, preState),
  );
  console.log(
    `Version metadata OK: computer ${components.computer.version}, relay ${components.core.version}, mobile ${components.mobile.version}.`,
  );
  console.log("Queued release majors match the owner's recorded approvals.");
}
