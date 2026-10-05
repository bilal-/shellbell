import { spawn } from "node:child_process";
import { once } from "node:events";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { expect, it } from "vitest";
import { openRelayDatabase } from "../src/storage/database.js";
import { acquireOwnership } from "../src/storage/ownership.js";
import { computerFixture, temporaryDirectory } from "./helpers.js";

const options = { attentive: () => false };
it("excludes a second process before application migration and releases the OS lock after abrupt death", async () => {
  const dir = temporaryDirectory();
  const child = spawn(
    process.execPath,
    [
      "--expose-gc",
      "--import",
      "tsx",
      "--input-type=module",
      "-e",
      `
    import { openRelayDatabase } from './src/storage/database.ts';
    const database = openRelayDatabase(process.argv[1], { attentive: () => false });
    // Match the real server's lifetime: discarding this handle lets GC release
    // the OS lock even though the fixture process is still alive.
    process.on('SIGTERM', () => { database.close(); process.exit(0); });
    global.gc();
    process.stdout.write('ready');
    setInterval(() => {}, 1000);
  `,
      dir,
    ],
    { cwd: new URL("..", import.meta.url), stdio: ["ignore", "pipe", "pipe"] },
  );
  let stderr = "";
  child.stderr.on("data", (chunk) => {
    stderr += chunk;
  });
  try {
    await Promise.race([
      once(child.stdout, "data"),
      once(child, "exit").then(() => {
        throw new Error(`owner exited before ready: ${stderr}`);
      }),
    ]);
    const lock = lstatSync(join(dir, "ownership.sqlite"));
    const before = readFileSync(join(dir, "relay.sqlite"));
    expect(() => openRelayDatabase(dir, options)).toThrow(/owned|locked/i);
    expect(readFileSync(join(dir, "relay.sqlite"))).toEqual(before);
    const exited = once(child, "exit");
    child.kill("SIGKILL");
    await exited;
    const recovered = openRelayDatabase(dir, options);
    expect(lstatSync(join(dir, "ownership.sqlite")).ino).toBe(lock.ino);
    await recovered.close();
  } finally {
    if (child.exitCode === null && child.signalCode === null) {
      const exited = once(child, "exit");
      child.kill("SIGKILL");
      await exited;
    }
    rmSync(dir, { recursive: true });
  }
});
it("creates private durable files, persists state, and invalidates old repository handles before ownership release", async () => {
  const parent = temporaryDirectory();
  const dir = join(parent, "data");
  try {
    const database = openRelayDatabase(dir, options);
    const computer = computerFixture();
    const store = database.identity(computer.fingerprint);
    await store.registerComputer(computer);
    for (const path of [
      dir,
      ...["relay.sqlite", "relay.sqlite-wal", "relay.sqlite-shm", "ownership.sqlite"].map((file) =>
        join(dir, file),
      ),
    ]) {
      expect(lstatSync(path).mode & 0o077).toBe(0);
    }
    await database.close();
    const replacement = openRelayDatabase(dir, options);
    await expect(store.markSeen(999)).rejects.toThrow();
    expect(await replacement.identity(computer.fingerprint).computer()).toEqual(computer);
    await replacement.close();
  } finally {
    rmSync(parent, { recursive: true });
  }
});
it.each([
  "directory-symlink",
  "ancestor-symlink",
  "file-symlink",
  "insecure-directory",
  "insecure-file",
  "unsupported-schema",
])("rejects %s before opening application data", async (kind) => {
  const parent = temporaryDirectory();
  const dir = join(parent, "data");
  mkdirSync(dir, { mode: 0o700 });
  let target = dir;
  try {
    if (kind === "directory-symlink" || kind === "ancestor-symlink") {
      target = join(parent, "link");
      symlinkSync(dir, target);
      if (kind === "ancestor-symlink") target = join(target, "nested");
    } else if (kind === "insecure-directory") chmodSync(dir, 0o755);
    else if (kind === "file-symlink") {
      writeFileSync(join(parent, "outside"), "untouched", { mode: 0o600 });
      symlinkSync(join(parent, "outside"), join(dir, "relay.sqlite"));
    } else if (kind === "insecure-file")
      writeFileSync(join(dir, "relay.sqlite"), "", { mode: 0o644 });
    else {
      const db = new DatabaseSync(join(dir, "relay.sqlite"));
      db.exec(
        "PRAGMA user_version = 99; CREATE TABLE sentinel(value TEXT); INSERT INTO sentinel VALUES ('untouched')",
      );
      db.close();
      chmodSync(join(dir, "relay.sqlite"), 0o600);
    }
    expect(() => openRelayDatabase(target, options)).toThrow();
    if (kind === "file-symlink")
      expect(readFileSync(join(parent, "outside"), "utf8")).toBe("untouched");
    if (kind === "unsupported-schema") {
      const db = new DatabaseSync(join(dir, "relay.sqlite"));
      expect(db.prepare("PRAGMA user_version").get()!.user_version).toBe(99);
      expect(db.prepare("SELECT value FROM sentinel").get()!.value).toBe("untouched");
      db.close();
      // Unsupported versions must release the ownership lock on their error path.
      const release = acquireOwnership(dir);
      release();
    }
  } finally {
    rmSync(parent, { recursive: true });
  }
});

it("rejects an unsupported Node version before creating the directory", async () => {
  const parent = temporaryDirectory();
  const dir = join(parent, "data");
  const child = spawn(
    process.execPath,
    [
      "--import",
      "tsx",
      "--input-type=module",
      "-e",
      `
    import { openRelayDatabase } from './src/storage/database.ts';
    Object.defineProperty(process.versions, 'node', { value: '22.0.0' });
    try { openRelayDatabase(process.argv[1], { attentive: () => false }); process.exitCode = 1; }
    catch (error) { if (!error.message.includes('22.23.1')) process.exitCode = 2; }
  `,
      dir,
    ],
    { cwd: new URL("..", import.meta.url), stdio: "ignore" },
  );
  try {
    const [code] = await once(child, "exit");
    expect(code).toBe(0);
    expect(existsSync(dir)).toBe(false);
  } finally {
    rmSync(parent, { recursive: true });
  }
});
it("requires a synchronous attentiveness dependency before creating data", () => {
  const parent = temporaryDirectory();
  const dir = join(parent, "data");
  try {
    expect(() => openRelayDatabase(dir, undefined as never)).toThrow(/attentive/);
    expect(existsSync(dir)).toBe(false);
  } finally {
    rmSync(parent, { recursive: true });
  }
});
