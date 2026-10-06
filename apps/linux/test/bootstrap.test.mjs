import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { gzipSync } from "node:zlib";

const script = new URL("../install.sh", import.meta.url).pathname;
for (const version of ["2.28", "2.29", "2.30"]) {
  test(`bootstrap checks the native WebRTC glibc minimum: ${version}`, () => {
    const home = mkdtempSync(join(tmpdir(), "sb-glibc-"));
    const bin = join(home, "bin");
    mkdirSync(bin);
    writeFileSync(join(bin, "getconf"), `#!/bin/sh\nprintf 'glibc ${version}\\n'\n`, {
      mode: 0o755,
    });
    // Bootstrap deliberately resets PATH. Replace only the OS probe in a
    // disposable script copy; retain the product's PATH and other admission checks.
    const probe = `'${join(bin, "getconf").replaceAll("'", "'\\''")}' GNU_LIBC_VERSION`;
    const source = readFileSync(script, "utf8");
    assert.equal(source.split("getconf GNU_LIBC_VERSION").length, 2);
    const copy = join(home, "install.sh");
    writeFileSync(copy, source.replace("getconf GNU_LIBC_VERSION", probe));
    try {
      const result = spawnSync(
        "/bin/sh",
        [copy, "--archive", "/nonexistent", "--sha256", "0".repeat(64)],
        {
          env: { PATH: `${bin}:/usr/bin:/bin`, HOME: home },
          encoding: "utf8",
          timeout: 15000,
        },
      );
      assert.notEqual(result.status, 0);
      if (version === "2.30") assert.match(result.stderr, /archive must be a regular file/);
      else {
        assert.match(result.stderr, /glibc 2\.30 or newer/);
        assert.equal(
          readdirSync(home).some((name) => name.startsWith(".shellbell-install.")),
          false,
        );
      }
      assert.equal(existsSync(join(home, ".local")), false);
    } finally {
      rmSync(home, { recursive: true });
    }
  });
}
test("bootstrap refuses writable HOME ancestors before staging downloaded code", () => {
  const parent = mkdtempSync(join(tmpdir(), "sb-ancestor-"));
  const home = join(parent, "home");
  mkdirSync(home, { mode: 0o700 });
  chmodSync(parent, 0o777);
  try {
    const result = spawnSync(
      "/bin/sh",
      [script, "--archive", "/nonexistent", "--sha256", "0".repeat(64)],
      {
        encoding: "utf8",
        env: { PATH: "/usr/bin:/bin", HOME: home },
        timeout: 15000,
      },
    );
    assert.match(result.stderr, /unsafe HOME ancestor/);
    // Rosetta may create ~/.cache before any shell code runs. Assert the
    // installer boundary, not unrelated emulator side effects.
    assert.equal(
      readdirSync(home).some((name) => name.startsWith(".shellbell-install.")),
      false,
    );
    assert.equal(existsSync(join(home, ".local")), false);
  } finally {
    rmSync(parent, { recursive: true });
  }
});
test("bootstrap stages only through canonical HOME, never a replaceable ancestor alias", () => {
  const root = mkdtempSync(join(tmpdir(), "sb-alias-"));
  const safe = join(root, "safe");
  mkdirSync(safe, { mode: 0o700 });
  const home = join(safe, "home");
  mkdirSync(home, { mode: 0o700 });
  const unsafe = join(root, "unsafe");
  mkdirSync(unsafe);
  chmodSync(unsafe, 0o777);
  symlinkSync(safe, join(unsafe, "alias"));
  try {
    const result = spawnSync(
      "/bin/sh",
      [script, "--archive", "/nonexistent", "--sha256", "0".repeat(64)],
      {
        encoding: "utf8",
        env: { PATH: "/usr/bin:/bin", HOME: join(unsafe, "alias/home") },
        timeout: 15000,
      },
    );
    assert.match(result.stderr, /archive must be a regular file/);
    assert.equal(
      result.stderr.includes(`Shellbell staging directory: ${home}/.shellbell-install.`),
      true,
    );
    assert.equal(result.stderr.includes(unsafe), false);
    assert.equal(existsSync(join(home, ".local")), false);
  } finally {
    rmSync(root, { recursive: true });
  }
});
function tar(entries) {
  const blocks = [];
  for (const { name, type = "0", body = "fixture", mode = "0000644", link = "" } of entries) {
    const data = Buffer.from(body);
    const h = Buffer.alloc(512);
    h.write(name, 0, 100);
    h.write(mode, 100, 7);
    h.write("0001750", 108, 7);
    h.write("0001750", 116, 7);
    h.write(data.length.toString(8).padStart(11, "0"), 124, 11);
    h.write("00000000000", 136, 11);
    h.fill(32, 148, 156);
    h.write(type, 156, 1);
    h.write(link, 157, 100);
    h.write("ustar\0", 257);
    h.write("00", 263);
    const checksum = h.reduce((sum, b) => sum + b, 0);
    h.write(checksum.toString(8).padStart(6, "0"), 148, 6);
    h[154] = 0;
    blocks.push(h, data, Buffer.alloc((512 - (data.length % 512)) % 512));
  }
  return gzipSync(Buffer.concat([...blocks, Buffer.alloc(1024)]));
}
function requiredMembers() {
  return [
    { name: "shellbell/runtime/bin/node", body: "not executable ELF", mode: "0000755" },
    ...[
      "inventory.json",
      "runtime/LICENSE",
      "install.mjs",
      "agent/dist/cli.js",
      "agent/package.json",
    ].map((name) => ({ name: `shellbell/${name}` })),
  ];
}
function run(entries, badChecksum = false) {
  const home = mkdtempSync(join(tmpdir(), "sb-bootstrap-"));
  const archive = join(home, "fixture.tar.gz");
  const bytes = tar(entries);
  writeFileSync(archive, bytes);
  const checksum = badChecksum ? "0".repeat(64) : createHash("sha256").update(bytes).digest("hex");
  const result = spawnSync("/bin/sh", [script, "--archive", archive, "--sha256", checksum], {
    encoding: "utf8",
    timeout: 15000,
    env: { PATH: "/usr/bin:/bin", HOME: home },
  });
  assert.equal(result.error, undefined);
  assert.equal(result.signal, null);
  assert.equal(existsSync(join(home, ".local/bin/shellbell")), false);
  const stage = readdirSync(home).find((name) => name.startsWith(".shellbell-install."));
  result.extracted = Boolean(stage && existsSync(join(home, stage, "extracted")));
  const runtime = stage && join(home, stage, "extracted/shellbell/runtime/bin/node");
  result.runtimeMode = runtime && existsSync(runtime) ? statSync(runtime).mode & 0o777 : null;
  rmSync(home, { recursive: true });
  return result;
}

test("bootstrap rejects checksum mismatch before archive parsing", () => {
  const result = run([{ name: "shellbell/file" }], true);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /checksum mismatch/);
});
test("admitted archive extraction preserves inventoried file modes", () => {
  const result = run(requiredMembers());
  assert.match(result.stderr, /runtime is not a Linux ELF64 executable/);
  assert.equal(result.runtimeMode, 0o755);
});
for (const [name, entry] of [
  ["traversal", { name: "shellbell/../../escape" }],
  ["absolute", { name: "/tmp/escape" }],
  ["newline", { name: "shellbell/bad\nname" }],
  ["symlink", { name: "shellbell/link", type: "2", link: "../../escape", body: "" }],
  ["hardlink", { name: "shellbell/link", type: "1", link: "../../escape", body: "" }],
  ["special", { name: "shellbell/device", type: "3", body: "" }],
  ["writable", { name: "shellbell/file", mode: "0000666" }],
])
  test(`bootstrap rejects ${name} before extraction`, () => {
    const result = run([...requiredMembers(), entry]);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /unsafe archive|archive listing failed/);
    assert.equal(result.extracted, false);
  });
test("bootstrap rejects duplicate member names", () => {
  const result = run([
    ...requiredMembers(),
    { name: "shellbell/file" },
    { name: "shellbell/file" },
  ]);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /unsafe archive/);
  assert.equal(result.extracted, false);
});
test("bootstrap rejects a structurally incomplete payload before running it", () => {
  const result = run([{ name: "shellbell/file" }]);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /unsafe archive/);
});
