import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chownSync, mkdirSync, readFileSync } from "node:fs";
import { setTimeout as delay } from "node:timers/promises";

assert.equal(process.getuid(), 0, "only the disposable coordinator runs as root");
const users = [1000, 1001];
const homes = new Map(users.map((uid) => [uid, `/work/user${uid}`]));
const agents = [];
const sha = (p) => createHash("sha256").update(readFileSync(p)).digest("hex");
const checksum = sha("/opt/archive.tar.gz");
function options(uid) {
  const home = homes.get(uid);
  return {
    uid,
    gid: uid,
    cwd: "/work",
    env: {
      PATH: "/usr/bin:/bin",
      HOME: home,
      SHELLBELL_DIR: `${home}/state`,
      XDG_RUNTIME_DIR: `${home}/runtime`,
      TERM: "xterm",
      SHELL: "/bin/sh",
    },
  };
}
function run(uid, file, args) {
  const r = spawnSync(file, args, { ...options(uid), encoding: "utf8", timeout: 120000 });
  assert.equal(r.error, undefined);
  assert.equal(r.signal, null);
  return r;
}
function cli(uid, args) {
  return run(uid, `${homes.get(uid)}/.local/bin/shellbell`, args);
}
function status(uid) {
  const r = cli(uid, ["--json", "status"]);
  assert.equal(r.status, 0, r.stderr);
  return JSON.parse(r.stdout);
}
async function waitFor(label, predicate) {
  const deadline = Date.now() + 30000;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await delay(100);
  }
  throw Error(`Timeout: ${label}`);
}
const identities = new Map();
try {
  for (const uid of users) {
    const home = homes.get(uid);
    mkdirSync(home, { mode: 0o700 });
    mkdirSync(`${home}/runtime`, { mode: 0o700 });
    chownSync(`${home}/runtime`, uid, uid);
    chownSync(home, uid, uid);
    const installed = run(uid, "/bin/sh", [
      "/opt/install.sh",
      "--archive",
      "/opt/archive.tar.gz",
      "--sha256",
      checksum,
    ]);
    assert.equal(installed.status, 0, installed.stderr);
    const initialized = cli(uid, ["--json", "host", "init", "--new"]);
    assert.equal(initialized.status, 0, initialized.stderr);
    assert.equal(JSON.parse(initialized.stdout).status, "initialized");
    // A child reads its own bytes; root coordinator deliberately lacks DAC override.
    const fingerprint = run(uid, process.execPath, [
      "-e",
      "const fs=require('fs'),c=require('crypto');console.log(c.createHash('sha256').update(fs.readFileSync(process.env.SHELLBELL_DIR+'/identity.json')).digest('hex'))",
    ]);
    assert.equal(fingerprint.status, 0);
    identities.set(uid, fingerprint.stdout.trim());
    const created = run(uid, "/usr/bin/tmux", [
      "-f",
      "/dev/null",
      "new-session",
      "-d",
      "-s",
      `fixture-${uid}`,
      "/bin/sh",
    ]);
    assert.equal(created.status, 0, created.stderr);
    if (uid === 1001)
      assert.equal(
        run(uid, "/usr/bin/tmux", ["split-window", "-d", "-t", `fixture-${uid}`, "/bin/sh"]).status,
        0,
      );
    const agent = spawn(`${home}/.local/bin/shellbell`, ["--relay", "wss://127.0.0.1:1", "start"], {
      ...options(uid),
      stdio: "ignore",
    });
    agents.push({ uid, agent });
  }
  assert.notEqual(identities.get(1000), identities.get(1001));
  await waitFor(
    "independent pane counts",
    () => status(1000).sessions === 1 && status(1001).sessions === 2,
  );
  assert.notEqual(status(1000).process.computerFp, status(1001).process.computerFp);
  for (const uid of users) {
    const other = uid === 1000 ? 1001 : 1000;
    const denied = run(uid, process.execPath, [
      "-e",
      `try{require('fs').readFileSync('${homes.get(other)}/state/identity.json');process.exit(2)}catch(e){if(e.code!=='EACCES')throw e}`,
    ]);
    assert.equal(denied.status, 0, "cross-user identity read must be denied");
    const busy = run(uid, process.execPath, ["/opt/payload/install.mjs", "--uninstall"]);
    assert.notEqual(busy.status, 0, "live installed agent blocks removal");
  }
  assert.equal(
    run(1000, process.execPath, ["-e", `process.kill(${agents[0].agent.pid},'SIGTERM')`]).status,
    0,
  );
  await waitFor(
    "agent A exit",
    () => agents[0].agent.exitCode !== null && status(1000).running === false,
  );
  const removed = run(1000, process.execPath, ["/opt/payload/install.mjs", "--uninstall"]);
  assert.equal(removed.status, 0, removed.stderr);
  assert.equal(agents[1].agent.exitCode, null);
  assert.equal(status(1001).sessions, 2);
  for (const uid of users)
    assert.equal(run(uid, "/usr/bin/tmux", ["has-session", "-t", `fixture-${uid}`]).status, 0);
  console.log(
    JSON.stringify({
      arch: process.arch,
      checks: [
        "two per-user archive installs",
        "different host identities",
        "cross-user credential reads denied",
        "concurrent one/two-pane agents",
        "live-runtime removal refused",
        "stopping/removing A preserves B and both tmux sessions",
      ],
    }),
  );
} finally {
  for (const { uid, agent } of agents)
    if (agent.exitCode === null && agent.pid)
      run(uid, process.execPath, [
        "-e",
        `try{process.kill(${agent.pid},'SIGTERM')}catch(e){if(e.code!=='ESRCH')throw e}`,
      ]);
  await waitFor("all fixture agents exit", () =>
    agents.every(({ agent }) => agent.exitCode !== null || agent.signalCode !== null),
  );
  for (const uid of users) run(uid, "/usr/bin/tmux", ["kill-server"]);
}
