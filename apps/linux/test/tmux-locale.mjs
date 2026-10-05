import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

// Runs only in the disposable, network-disabled archive qualification container.
assert.equal(process.platform, "linux");
assert.equal(process.getuid(), 1000);
const home = process.env.HOME;
assert.equal(home, "/work/home with spaces");
mkdirSync(home, { mode: 0o700 });
const state = join(home, "state");
const runtime = join(home, "runtime");
mkdirSync(runtime, { mode: 0o700 });
const env = {
  HOME: home,
  PATH: "/usr/bin:/bin",
  SHELLBELL_DIR: state,
  XDG_RUNTIME_DIR: runtime,
  LC_ALL: "C",
  LC_CTYPE: "C",
  LANG: "C",
};
const launcher = join(home, ".local/bin/shellbell");
function run(file, args) {
  const result = spawnSync(file, args, { env, encoding: "utf8", timeout: 120000 });
  assert.equal(result.status, 0, result.stderr || result.error?.message);
  return result.stdout;
}
function cli(...args) {
  return run(launcher, args);
}
async function waitFor(label, predicate) {
  const deadline = Date.now() + 30000;
  while (!(await predicate())) {
    assert.ok(Date.now() < deadline, `timed out: ${label}`);
    await delay(100);
  }
}
function logs() {
  const file = join(state, "agent.log");
  if (!existsSync(file)) return [];
  return readFileSync(file, "utf8")
    .split("\n")
    .filter(Boolean)
    .flatMap((line) => {
      try {
        return [JSON.parse(line)];
      } catch {
        return []; // A concurrent append can leave the final line incomplete.
      }
    });
}
const checksum = createHash("sha256").update(readFileSync("/opt/archive.tar.gz")).digest("hex");
run("/bin/sh", ["/opt/install.sh", "--archive", "/opt/archive.tar.gz", "--sha256", checksum]);
assert.equal(JSON.parse(cli("--json", "host", "init", "--new")).status, "initialized");
cli("config", "set", "idleQuietMs", "4000");
cli("config", "set", "idleMinActiveMs", "1500");
let agent;
let serverCreated = false;
try {
  run("tmux", ["-f", "/dev/null", "new-session", "-d", "-s", "locale-qa", "-n", "qa-π", "/bin/sh"]);
  serverCreated = true;
  // No remote relay or phone is contacted. This tests local event detection only.
  agent = spawn(launcher, ["--relay", "wss://127.0.0.1:1", "start"], { env, stdio: "ignore" });
  await waitFor("tmux discovered", () => JSON.parse(cli("--json", "status")).sessions === 1);
  run("tmux", [
    "send-keys",
    "-t",
    "locale-qa:0.0",
    "-l",
    "for i in 1 2 3 4 5; do printf 'synthetic locale check\\n'; sleep 1; done",
  ]);
  run("tmux", ["send-keys", "-t", "locale-qa:0.0", "Enter"]);
  await waitFor("idle ring with canonical pane ID under C locale", () =>
    logs().some(
      (record) => record.msg === "ring" && record.session === "tmux:%0" && record.kind === "idle",
    ),
  );
  console.log(
    JSON.stringify({
      platform: process.platform,
      arch: process.arch,
      checks: [
        "real archive install",
        "C locale",
        "real tmux output",
        "canonical tmux pane ID",
        "idle ring",
      ],
      providerDeliveryTested: false,
    }),
  );
} finally {
  try {
    if (agent?.pid && agent.exitCode === null && agent.signalCode === null) agent.kill("SIGTERM");
    if (agent)
      await waitFor(
        "fixture agent exit",
        () => agent.exitCode !== null || agent.signalCode !== null,
      );
  } finally {
    if (serverCreated) run("tmux", ["kill-server"]);
  }
}
