import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { verifyPayload, writeInventory } from "/opt/payload/scripts/payload.mjs";

const home = process.env.HOME;
const launcher = join(home, ".local/bin/shellbell");
const base = join(home, ".local/share/shellbell/installs", `linux-${process.arch}`);
const initial = readlinkSync(join(base, "current"));
const initialPath = join(base, initial);
const state = join(home, "state");
const env = {
  PATH: "/usr/bin:/bin",
  HOME: home,
  SHELLBELL_DIR: state,
  XDG_RUNTIME_DIR: join(home, "runtime"),
};
mkdirSync(env.XDG_RUNTIME_DIR, { mode: 0o700 });
function run(file, args, success = true) {
  const r = spawnSync(file, args, { env, encoding: "utf8", timeout: 120000 });
  assert.equal(r.error, undefined);
  assert.equal(r.signal, null, r.stderr);
  if (success) assert.equal(r.status, 0, r.stderr);
  else assert.notEqual(r.status, 0);
  return r;
}
function install(archive, checksum) {
  return run("/bin/sh", ["/opt/install.sh", "--archive", archive, "--sha256", checksum]);
}
const sha = (p) => createHash("sha256").update(readFileSync(p)).digest("hex");
assert.equal(existsSync(state), false);
assert.equal(existsSync(join(home, ".local/state/shellbell")), false);
const initialVersion = run(launcher, ["--version"]).stdout.trim();
assert.equal(
  initialVersion,
  (await verifyPayload(initialPath)).version,
  "launcher must run the installed version",
);
run(launcher, ["--help"]);
const initialized = run(launcher, ["--json", "host", "init", "--new"]);
assert.equal(JSON.parse(initialized.stdout).status, "initialized");
const snapshot = () =>
  Object.fromEntries(readdirSync(state).map((name) => [name, sha(join(state, name))]));
const before = snapshot();

// Exercise service admission on the real payload, before the synthetic version
// wrapper changes the CLI entry point. This container has no per-user bus.
assert.equal(existsSync(`/run/user/${process.getuid()}/bus`), false);
const serviceBefore = JSON.parse(run(launcher, ["--json", "service", "status"], false).stdout);
const registered = run(launcher, ["--json", "service", "install"], false);
assert.equal(registered.status, 2);
assert.equal(registered.stderr, "");
assert.deepEqual(
  JSON.parse(registered.stdout),
  {
    error:
      "shellbell: systemd manager ownership is unavailable, foreign or unresolved; inspect exact unit discovery and overrides",
  },
  "service install must report unresolved manager ownership",
);
const serviceAfter = JSON.parse(run(launcher, ["--json", "service", "status"], false).stdout);
for (const status of [serviceBefore, serviceAfter]) {
  assert.equal(status.manager, "systemd");
  assert.equal(status.installed, false);
  assert.equal(status.enabled, false);
  assert.equal(status.autostartConfigured, false);
  assert.equal(status.startupEnabled, null);
  assert.equal(status.activeState, "unknown");
  assert.equal(status.managedPid, null);
  assert.equal(status.ready, false);
  assert.match(status.unitName, /^shellbell-[a-f0-9]{32}\.service$/);
  assert.equal(status.definitionPath, join(home, ".config/systemd/user", status.unitName));
  assert.equal(
    existsSync(status.definitionPath),
    false,
    "refused installation must leave no systemd unit",
  );
  assert.equal(
    existsSync(join(home, ".config/systemd/user/default.target.wants", status.unitName)),
    false,
    "refused installation must leave no systemd enablement",
  );
}
assert.equal(serviceAfter.definitionPath, serviceBefore.definitionPath);
assert.deepEqual(snapshot(), before);

install("/opt/archive.tar.gz", sha("/opt/archive.tar.gz"));
assert.deepEqual(snapshot(), before);
run(
  "/bin/sh",
  ["/opt/install.sh", "--archive", "/opt/archive.tar.gz", "--sha256", "0".repeat(64)],
  false,
);
assert.equal(readlinkSync(join(base, "current")), initial);
assert.equal(
  run(launcher, ["--version"]).stdout.trim(),
  initialVersion,
  "checksum refusal must preserve the working version",
);

// Synthetic upgrade fixture: identical agent source, deliberately changed
// package/inventory version. This exercises switching, not a second release.
const candidate = join(home, "candidate");
cpSync("/opt/payload", candidate, { recursive: true });
const metadata = await verifyPayload(candidate);
const next = "0.0.999-installer-fixture";
// Version is inlined in built shared chunks. A test-only wrapper changes only
// --version while retaining the actual agent for --help and normal commands.
renameSync(join(candidate, "agent/dist/cli.js"), join(candidate, "agent/dist/cli-original.js"));
writeFileSync(
  join(candidate, "agent/dist/cli.js"),
  `import {fileURLToPath} from 'node:url';if(process.argv.includes('--version'))console.log(${JSON.stringify(next)});else {process.argv[1]=fileURLToPath(new URL('./cli-original.js',import.meta.url));await import('./cli-original.js');}`,
);
const pkgPath = join(candidate, "agent/package.json");
writeFileSync(
  pkgPath,
  JSON.stringify({ ...JSON.parse(readFileSync(pkgPath, "utf8")), version: next }),
);
rmSync(join(candidate, "inventory.json"));
const { schema: _schema, files: _files, ...meta } = metadata;
await writeInventory(candidate, { ...meta, version: next });
const archive = join(home, "upgrade.tar.gz");
// The bootstrap requires one shellbell root, so stage that exact wrapper.
const wrapper = join(home, "wrapper");
mkdirSync(wrapper);
cpSync(candidate, join(wrapper, "shellbell"), { recursive: true });
run("/usr/bin/tar", ["--format=ustar", "-czf", archive, "-C", wrapper, "shellbell"]);
install(archive, sha(archive));
assert.equal(readlinkSync(join(base, "current")), next);
await verifyPayload(initialPath);
assert.deepEqual(snapshot(), before);
assert.equal(
  run(launcher, ["--version"]).stdout.trim(),
  next,
  "launcher must run the upgraded version",
);
assert.deepEqual(snapshot(), before);
console.log(
  JSON.stringify({
    platform: process.platform,
    arch: process.arch,
    node: process.version,
    checks: [
      "no system Node/npm",
      "actual shell archive install",
      "spaces in HOME",
      "version/help",
      "explicit host initialization",
      "repeat preserves identity",
      "checksum failure preserves working version",
      "synthetic version upgrade retains old payload",
      "service install without user manager fails",
    ],
    serviceProbe: registered.stdout.trim(),
  }),
);

// Execute removal from the external harness runtime: an installed runtime
// running this harness would correctly make itself busy to a child uninstaller.
run(process.execPath, ["/opt/payload/install.mjs", "--uninstall"]);
assert.equal(existsSync(launcher), false);
assert.equal(existsSync(initialPath), false);
assert.equal(existsSync(join(base, next)), false);
assert.deepEqual(snapshot(), before);
console.log("Managed removal preserved initialized host state.");
