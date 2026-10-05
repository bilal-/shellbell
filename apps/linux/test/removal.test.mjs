import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { once } from "node:events";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import * as installer from "../scripts/install-lib.mjs";
import { runtimeManifest, writeInventory } from "../scripts/payload.mjs";

test("installer CLI refuses missing HOME instead of selecting the working directory", () => {
  const result = spawnSync(
    process.execPath,
    [new URL("../install.mjs", import.meta.url).pathname],
    {
      env: { PATH: "/usr/bin:/bin" },
      encoding: "utf8",
    },
  );
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /invalid-home/);
});

function put(path, text, mode = 0o644) {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  writeFileSync(path, text, { mode });
}
async function fixture() {
  const root = mkdtempSync(join(tmpdir(), "sb-remove-"));
  const home = join(root, "home with spaces");
  mkdirSync(home, { mode: 0o700 });
  const payload = join(root, "payload");
  put(
    join(payload, "runtime/bin/node"),
    "#!/bin/sh\ncase \"$2\" in --help) echo 'Usage: shellbell [options]' ;; *) echo '0.0.1' ;; esac\n",
    0o755,
  );
  put(join(payload, "runtime/LICENSE"), "license");
  put(join(payload, "licenses/Shellbell-LICENSE"), "license");
  put(
    join(payload, "agent/package.json"),
    JSON.stringify({ name: "shellbell", type: "module", version: "0.0.1" }),
  );
  put(join(payload, "agent/dist/cli.js"), "fixture");
  put(join(payload, "install.mjs"), "fixture");
  await writeInventory(payload, {
    version: "0.0.1",
    arch: process.arch,
    sourceCommit: "a".repeat(40),
    runtimeVersion: runtimeManifest.version,
    runtimeArchiveSha256: runtimeManifest.archives[process.arch].sha256,
  });
  await installer.installPayload({ payload, home });
  const state = join(home, ".local/state/shellbell/pairings.json");
  put(state, "preserve me");
  const location = join(home, ".local/share/shellbell/installs", `linux-${process.arch}`, "0.0.1");
  return { root, home, state, location };
}
for (const [name, source] of [
  ["import crash", "throw Error('broken candidate import')"],
  [
    "hung help",
    "if(process.argv.includes('--version')) console.log('0.0.2');else setInterval(()=>{},100)",
  ],
  ["wrong version", "console.log('9.9.9')"],
]) {
  test(`CLI probe rejects ${name} before replacing the working version`, async () => {
    const f = await fixture();
    try {
      const input = join(f.root, "payload");
      const inventory = JSON.parse(readFileSync(join(input, "inventory.json"), "utf8"));
      copyFileSync(process.execPath, join(input, "runtime/bin/node"));
      writeFileSync(join(input, "agent/dist/cli.js"), source);
      writeFileSync(
        join(input, "agent/package.json"),
        JSON.stringify({ name: "shellbell", type: "module", version: "0.0.2" }),
      );
      rmSync(join(input, "inventory.json"));
      const { schema: _schema, files: _files, ...meta } = inventory;
      await writeInventory(input, { ...meta, version: "0.0.2" });
      await assert.rejects(installer.installPayload({ home: f.home, payload: input }), /cli-probe/);
      assert.equal(readlinkSync(join(dirname(f.location), "current")), "0.0.1");
      assert.equal(readFileSync(f.state, "utf8"), "preserve me");
      assert.equal(existsSync(join(f.home, ".local/bin/shellbell")), true);
    } finally {
      rmSync(f.root, { recursive: true });
    }
  });
}
test("interruption before current switch preserves old launcher, state and a refusing lock", async () => {
  const f = await fixture();
  const input = join(f.root, "payload");
  const inventory = JSON.parse(readFileSync(join(input, "inventory.json"), "utf8"));
  writeFileSync(
    join(input, "runtime/bin/node"),
    "#!/bin/sh\ncase \"$2\" in --help) echo 'Usage: shellbell [options]' ;; *) echo '0.0.2' ;; esac\n",
  );
  writeFileSync(
    join(input, "agent/package.json"),
    JSON.stringify({ name: "shellbell", type: "module", version: "0.0.2" }),
  );
  rmSync(join(input, "inventory.json"));
  const { schema: _schema, files: _files, ...meta } = inventory;
  await writeInventory(input, { ...meta, version: "0.0.2" });
  const module = new URL("../scripts/install-lib.mjs", import.meta.url).href;
  // A test-only filesystem boundary hook pauses immediately before the real
  // atomic rename. The product has no timing flags or testing backdoors.
  const source = `import fs from 'node:fs';import {syncBuiltinESMExports} from 'node:module';
    const original=fs.renameSync;
    fs.renameSync=(from,to)=>{if(to.endsWith('/current')){process.stdout.write('ready');Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0);}return original(from,to)};
    syncBuiltinESMExports();
    const {installPayload}=await import(${JSON.stringify(module)});
    await installPayload({home:${JSON.stringify(f.home)},payload:${JSON.stringify(input)}});`;
  const child = spawn(process.execPath, ["--input-type=module", "-e", source], {
    stdio: ["ignore", "pipe", "inherit"],
  });
  try {
    await once(child.stdout, "data", { signal: AbortSignal.timeout(10000) });
    const exited = once(child, "exit");
    child.kill("SIGKILL");
    await exited;
    assert.equal(readlinkSync(join(dirname(f.location), "current")), "0.0.1");
    const launch = spawnSync(join(f.home, ".local/bin/shellbell"), ["--version"], {
      env: { PATH: "/usr/bin:/bin", HOME: f.home },
      encoding: "utf8",
    });
    assert.equal(launch.status, 0, launch.stderr);
    assert.equal(readFileSync(f.state, "utf8"), "preserve me");
    await assert.rejects(installer.installPayload({ home: f.home, payload: input }), {
      code: "EEXIST",
    });
  } finally {
    if (child.exitCode === null && child.signalCode === null) {
      const exited = once(child, "exit");
      child.kill("SIGKILL");
      await exited;
    }
    rmSync(f.root, { recursive: true });
  }
});
test("killing a shell-bootstrap update preserves the working launcher and pairing state", async () => {
  const f = await fixture();
  let child;
  let closed;
  const killFixtureSession = () => {
    // GNU timeout creates a second process group, but retains the detached
    // shell's session. Limit cleanup to that exact disposable Linux session.
    for (const pid of readdirSync("/proc").filter((name) => /^\d+$/.test(name))) {
      try {
        const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
        const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
        if (Number(fields[3]) === child.pid) process.kill(Number(pid), "SIGKILL");
      } catch (error) {
        if (error.code !== "ENOENT" && error.code !== "ESRCH") throw error;
      }
    }
  };
  try {
    const payload = join(f.root, "payload");
    const inventory = JSON.parse(readFileSync(join(payload, "inventory.json"), "utf8"));
    copyFileSync(process.execPath, join(payload, "runtime/bin/node"));
    put(
      join(payload, "agent/package.json"),
      JSON.stringify({
        name: "shellbell",
        type: "module",
        version: "0.0.2",
      }),
    );
    put(
      join(payload, "agent/dist/cli.js"),
      "console.log(process.argv.includes('--help') ? 'Usage: shellbell [options]' : '0.0.2')",
    );
    for (const name of [
      "scripts/install-lib.mjs",
      "scripts/payload.mjs",
      "runtime-manifest.json",
    ]) {
      put(join(payload, name), readFileSync(new URL(`../${name}`, import.meta.url)));
    }
    put(
      join(payload, "actual-install.mjs"),
      readFileSync(new URL("../install.mjs", import.meta.url)),
    );
    // Only the test archive contains this hook. Pause at the actual filesystem
    // publication boundary, after the shell has admitted/extracted the archive.
    put(
      join(payload, "install.mjs"),
      `
      import fs from 'node:fs';
      import {syncBuiltinESMExports} from 'node:module';
      const rename = fs.renameSync;
      fs.renameSync = (from, to) => {
        if (to.endsWith('/current')) {
          fs.writeSync(1, 'ready-to-switch');
          Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0);
        }
        return rename(from, to);
      };
      syncBuiltinESMExports();
      await import('./actual-install.mjs');
    `,
    );
    rmSync(join(payload, "inventory.json"));
    const { schema: _schema, files: _files, ...metadata } = inventory;
    await writeInventory(payload, { ...metadata, version: "0.0.2" });
    const archive = join(f.root, "update.tar.gz");
    const packed = spawnSync(
      "tar",
      ["-czf", archive, "--transform=s,^payload,shellbell,", "-C", f.root, "payload"],
      { encoding: "utf8" },
    );
    assert.equal(packed.status, 0, packed.stderr);
    const digest = createHash("sha256").update(readFileSync(archive)).digest("hex");
    child = spawn(
      "/bin/sh",
      [
        new URL("../install.sh", import.meta.url).pathname,
        "--archive",
        archive,
        "--sha256",
        digest,
      ],
      {
        detached: true,
        env: { PATH: "/usr/bin:/bin", HOME: f.home },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    closed = once(child, "close", { signal: AbortSignal.timeout(30000) });
    let errors = "";
    child.stderr.on("data", (chunk) => {
      errors += chunk.toString();
    });
    const [ready] = await once(child.stdout, "data", { signal: AbortSignal.timeout(20000) });
    assert.equal(ready.toString(), "ready-to-switch", errors);
    killFixtureSession();
    await closed;
    assert.equal(readlinkSync(join(dirname(f.location), "current")), "0.0.1");
    const launch = spawnSync(join(f.home, ".local/bin/shellbell"), ["--version"], {
      env: { PATH: "/usr/bin:/bin", HOME: f.home },
      encoding: "utf8",
    });
    assert.equal(launch.status, 0, launch.stderr);
    assert.equal(launch.stdout.trim(), "0.0.1");
    assert.equal(readFileSync(f.state, "utf8"), "preserve me");
    const retry = spawnSync(
      "/bin/sh",
      [
        new URL("../install.sh", import.meta.url).pathname,
        "--archive",
        archive,
        "--sha256",
        digest,
      ],
      { env: { PATH: "/usr/bin:/bin", HOME: f.home }, encoding: "utf8", timeout: 20000 },
    );
    assert.notEqual(retry.status, 0);
    assert.match(retry.stderr, /EEXIST/);
    assert.equal(readlinkSync(join(dirname(f.location), "current")), "0.0.1");
    assert.equal(readFileSync(f.state, "utf8"), "preserve me");
  } finally {
    if (child) {
      killFixtureSession();
      await closed;
    }
    rmSync(f.root, { recursive: true });
  }
});

test("removal deletes only installed files and preserves pairing state", async () => {
  const f = await fixture();
  try {
    const result = spawnSync(
      process.execPath,
      [new URL("../install.mjs", import.meta.url).pathname, "--uninstall"],
      {
        env: { PATH: "/usr/bin:/bin", HOME: f.home },
        encoding: "utf8",
      },
    );
    assert.equal(result.status, 0, result.stderr);
    assert.equal(existsSync(f.location), false);
    assert.equal(existsSync(join(f.home, ".local/bin/shellbell")), false);
    assert.equal(readFileSync(f.state, "utf8"), "preserve me");
  } finally {
    rmSync(f.root, { recursive: true });
  }
});
test("an unrelated masked unit does not prevent safe removal", async () => {
  const f = await fixture();
  try {
    const units = join(f.home, ".config/systemd/user");
    mkdirSync(units, { recursive: true });
    symlinkSync("/dev/null", join(units, "unrelated.service"));
    await installer.removeInstallation({ home: f.home });
    assert.equal(existsSync(f.location), false);
    assert.equal(readlinkSync(join(units, "unrelated.service")), "/dev/null");
    assert.equal(readFileSync(f.state, "utf8"), "preserve me");
  } finally {
    rmSync(f.root, { recursive: true });
  }
});
for (const invocation of [
  "%h/.local/share/shellbell/installs",
  "shellbell",
  "\\x73\\x68\\x65\\x6c\\x6c\\x62\\x65\\x6c\\x6c",
]) {
  test(`removal refuses an indirect Shellbell unit marker: ${invocation}`, async () => {
    const f = await fixture();
    try {
      put(
        join(f.home, ".config/systemd/user/retained-agent.service"),
        `[Service]\nExecStart="${invocation}"\n`,
      );
      await assert.rejects(
        installer.removeInstallation({ home: f.home }),
        /service-references-installation/,
      );
      assert.equal(existsSync(join(f.location, "runtime/bin/node")), true);
    } finally {
      rmSync(f.root, { recursive: true });
    }
  });
}
for (const location of [
  "data",
  "data-override",
  "runtime",
  "transient",
  "generator",
  "config-dirs",
  "unit-path",
]) {
  test(`removal refuses a stopped service in the ${location} unit search path`, async () => {
    const f = await fixture();
    const saved = {};
    const set = (key, value) => {
      saved[key] = process.env[key];
      process.env[key] = value;
    };
    let unitDir;
    if (location === "data") unitDir = join(f.home, ".local/share/systemd/user");
    if (location === "data-override") {
      set("XDG_DATA_HOME", join(f.home, "data"));
      unitDir = join(f.home, "data/systemd/user");
    }
    if (["runtime", "transient", "generator"].includes(location)) {
      set("XDG_RUNTIME_DIR", join(f.home, "runtime"));
      unitDir = join(
        f.home,
        "runtime/systemd",
        { runtime: "user", transient: "transient", generator: "generator.early" }[location],
      );
    }
    if (location === "config-dirs") {
      set("XDG_CONFIG_DIRS", join(f.home, "config-extra"));
      unitDir = join(f.home, "config-extra/systemd/user");
    }
    if (location === "unit-path") {
      set("SYSTEMD_UNIT_PATH", join(f.home, "custom-units"));
      unitDir = join(f.home, "custom-units");
    }
    try {
      const unit = join(unitDir, "retained-agent.service");
      put(unit, `[Service]\nExecStart="${f.location}/runtime/bin/node"\n`);
      await assert.rejects(
        installer.removeInstallation({ home: f.home }),
        /service-references-installation/,
      );
      assert.equal(existsSync(unit), true);
      assert.equal(existsSync(join(f.location, "runtime/bin/node")), true);
      assert.equal(readFileSync(f.state, "utf8"), "preserve me");
    } finally {
      for (const [key, value] of Object.entries(saved)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
      rmSync(f.root, { recursive: true });
    }
  });
}
for (const kind of ["service", "extra-file", "extra-directory", "busy-process"])
  test(`removal refuses ${kind} without removing the working version`, async () => {
    const f = await fixture();
    let child;
    try {
      if (kind === "service")
        put(
          join(f.home, ".config/systemd/user/shellbell.service"),
          `[Service]\nExecStart="${f.location}/runtime/bin/node"\n`,
        );
      if (kind === "extra-file") put(join(f.location, "user-file"), "user data");
      if (kind === "extra-directory") mkdirSync(join(f.location, "user-directory"));
      if (kind === "busy-process") {
        child = spawn(
          process.execPath,
          ["-e", "console.log('ready');setInterval(()=>{},1000)", f.location],
          { stdio: ["ignore", "pipe", "inherit"] },
        );
        await once(child.stdout, "data");
      }
      await assert.rejects(installer.removeInstallation({ home: f.home }));
      assert.equal(existsSync(join(f.location, "runtime/bin/node")), true);
      assert.equal(existsSync(join(f.home, ".local/bin/shellbell")), true);
      assert.equal(readFileSync(f.state, "utf8"), "preserve me");
    } finally {
      if (child) {
        child.kill();
        await once(child, "exit");
      }
      rmSync(f.root, { recursive: true });
    }
  });
