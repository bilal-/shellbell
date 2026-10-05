import { execFileSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { NativeRecordTransaction } from "../src/native/protocol.js";
import { NativeRecordStore } from "../src/native/record-store.js";

const fixtures: string[] = [];
function fixture() {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "shellbell-native-record-")));
  fixtures.push(dir);
  const root = join(dir, "native");
  return {
    dir,
    root,
    path: join(root, "controller.json"),
    store: new NativeRecordStore({ root, uid: process.getuid!() }),
  };
}
const empty = { v: 1, selection: null, transition: null, recovery: null } as const;
const id = "fdbbc2c2-3279-4b21-a599-750048df6c83";
function privateFile(path: string, value: string) {
  writeFileSync(path, value, { mode: 0o600 });
}
function rendezvous() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
afterEach(() => {
  for (const dir of fixtures.splice(0)) rmSync(dir, { recursive: true, force: true });
});
describe("native record admission", () => {
  it("does not let a trailing separator hide a symlink root", () => {
    const { dir, root } = fixture();
    const target = join(dir, "private");
    mkdirSync(target, { mode: 0o700 });
    symlinkSync(target, root);
    expect(() =>
      new NativeRecordStore({ root: `${root}/`, uid: process.getuid!() }).inspect(),
    ).toThrowError(expect.objectContaining({ code: "unsafe-state" }));
    expect(readdirSync(target)).toEqual([]);
  });
  it("refuses publication when its cooperative guard was replaced", async () => {
    const { root, path, store } = fixture();
    await expect(
      store.mutate(null, async (tx) => {
        renameSync(`${path}.lock`, join(root, "displaced-guard"));
        mkdirSync(`${path}.lock`, { mode: 0o700 });
        privateFile(join(`${path}.lock`, `owner-${process.pid}-${id}`), "");
        tx.publish(empty);
      }),
    ).rejects.toMatchObject({ code: "unsafe-state" });
    expect(existsSync(path)).toBe(false);
    expect(existsSync(join(`${path}.lock`, `owner-${process.pid}-${id}`))).toBe(true);
  });
  it("reclaims a verified dead owner's guard without losing the saved transition", async () => {
    const { path, store } = fixture();
    const saved = await store.mutate(null, async (tx) =>
      tx.publish({
        ...empty,
        transition: {
          id,
          action: "start",
          phase: "prepared",
          source: null,
          destination: null,
          recoveryId: null,
        },
      }),
    );
    const deadPid = execFileSync(
      process.execPath,
      ["-e", "process.stdout.write(String(process.pid))"],
      { encoding: "utf8" },
    );
    mkdirSync(`${path}.lock`, { mode: 0o700 });
    privateFile(join(`${path}.lock`, `owner-${deadPid}-${id}`), "");
    await store.mutate(saved.revision, async (tx) => {
      expect(tx.current?.transition?.phase).toBe("prepared");
      tx.publish(empty);
    });
    expect(existsSync(`${path}.lock`)).toBe(false);
    expect(store.inspect()?.transition).toBeNull();
  });
  it("rejects invalid or reused revision generators without altering saved state", async () => {
    const { root, store } = fixture();
    const saved = await store.mutate(null, async (tx) => tx.publish(empty));
    for (const revision of ["bad-uuid", saved.revision]) {
      await expect(
        new NativeRecordStore({ root, uid: process.getuid!(), newId: () => revision }).mutate(
          saved.revision,
          async (tx) => tx.publish(empty),
        ),
      ).rejects.toMatchObject({ code: "unsafe-state" });
      expect(store.inspect()).toEqual(saved);
    }
  });
  it("stores private recovery larger than bridge lines but refuses a record beyond two MiB", async () => {
    const { root, path, store } = fixture();
    const recovery = {
      id,
      definitionPath: "/private/legacy.plist",
      rawBase64: Buffer.alloc(1024 * 1024, 65).toString("base64"),
      sha256: "b".repeat(64),
      wasLoaded: true,
      stateDir: "/private/state",
      computerFp: "a".repeat(26),
    };
    const saved = await store.mutate(null, async (tx) => tx.publish({ ...empty, recovery }));
    expect(lstatSync(path).size).toBeGreaterThan(65536);
    expect(store.inspect()).toEqual(saved);
    const selection = {
      mode: "manual" as const,
      stateDir: "/private/state",
      computerFp: "a".repeat(26),
      serviceInstance: id,
      bundlePath: "/Applications/Shellbell.app",
      bundleId: "sh.bilal.shellbell.host" as const,
      agentVersion: "a".repeat(2 * 1024 * 1024),
      environment: {
        PATH: "/bin",
        SHELLBELL_DIR: "/private/state",
        SHELLBELL_SERVICE_INSTANCE: id,
      },
    };
    await expect(
      store.mutate(saved.revision, async (tx) => tx.publish({ ...empty, selection })),
    ).rejects.toMatchObject({ code: "unsafe-state" });
    expect(store.inspect()).toEqual(saved);
    expect(readdirSync(root)).toEqual(["controller.json"]);
  });
  it("does not create an absent root during inspection", () => {
    const { root, store } = fixture();
    expect(store.inspect()).toBeNull();
    expect(existsSync(root)).toBe(false);
  });
  it("rejects a stale revision before entering the async action", async () => {
    const { store } = fixture();
    let touched = false;
    await expect(
      store.mutate("fdbbc2c2-3279-4b21-a599-750048df6c83", async () => {
        touched = true;
      }),
    ).rejects.toMatchObject({ code: "conflict" });
    expect(touched).toBe(false);
  });
  it("publishes private revisioned JSON that survives a new store instance", async () => {
    const { root, path, store } = fixture();
    const first = await store.mutate(null, async (tx) => tx.publish(empty));
    expect(first).toMatchObject(empty);
    expect(first).toHaveProperty("revision");
    expect(lstatSync(root).mode & 0o7777).toBe(0o700);
    expect(lstatSync(path).mode & 0o7777).toBe(0o600);
    expect(new NativeRecordStore({ root, uid: process.getuid!() }).inspect()).toEqual(first);
    const second = await store.mutate(first.revision, async (tx) => tx.publish(empty));
    expect(second.revision).not.toBe(first.revision);
    expect(JSON.parse(readFileSync(path, "utf8"))).toEqual(second);
    expect(readdirSync(root)).toEqual(["controller.json"]);
  });
  it("preserves the latest durable transition when an async operation throws", async () => {
    const { store } = fixture();
    await expect(
      store.mutate(null, async (tx) => {
        tx.publish({
          ...empty,
          transition: {
            id,
            action: "start",
            phase: "prepared",
            source: null,
            destination: null,
            recoveryId: null,
          },
        });
        await Promise.resolve();
        tx.publish({
          ...empty,
          transition: {
            id,
            action: "start",
            phase: "source-stop-requested",
            source: null,
            destination: null,
            recoveryId: null,
          },
        });
        throw new Error("sensitive manager output");
      }),
    ).rejects.toMatchObject({ code: "operation-failed", message: "operation-failed" });
    const saved = store.inspect();
    expect(saved?.transition?.phase).toBe("source-stop-requested");
    await expect(
      store.mutate(saved!.revision, async (tx) => tx.publish(empty)),
    ).resolves.toMatchObject(empty);
  });
  it("holds a cooperative guard across awaits without queuing another mutation", async () => {
    const { root, store } = fixture();
    const entered = rendezvous();
    const release = rendezvous();
    const first = store.mutate(null, async (tx) => {
      entered.resolve();
      await release.promise;
      return tx.publish(empty);
    });
    await entered.promise;
    let touched = false;
    try {
      await expect(
        new NativeRecordStore({ root, uid: process.getuid!() }).mutate(null, async () => {
          touched = true;
        }),
      ).rejects.toMatchObject({ code: "busy" });
      expect(touched).toBe(false);
    } finally {
      release.resolve();
    }
    await first;
    expect(readdirSync(root)).toEqual(["controller.json"]);
  });
  it("rejects malformed state and exact cap plus one before JSON parsing", () => {
    const { root, path, store } = fixture();
    mkdirSync(root, { mode: 0o700 });
    const json = JSON.stringify({ ...empty, revision: id });
    privateFile(path, json + " ".repeat(2 * 1024 * 1024 - Buffer.byteLength(json)));
    expect(store.inspect()).toEqual({ ...empty, revision: id });
    privateFile(path, `${readFileSync(path, "utf8")} `);
    expect(() => store.inspect()).toThrowError(expect.objectContaining({ code: "unsafe-state" }));
    for (const raw of [
      "sensitive malformed JSON",
      JSON.stringify({ ...empty, revision: id, unknown: true }),
      JSON.stringify({ ...empty, revision: "invalid" }),
    ]) {
      privateFile(path, raw);
      expect(() => store.inspect()).toThrowError(
        expect.objectContaining({ code: "unsafe-state", message: "unsafe-state" }),
      );
    }
  });
  it("never repairs an unsafe existing root or accepts a foreign owner", async () => {
    const { root, store } = fixture();
    mkdirSync(root, { mode: 0o755 });
    expect(() => store.inspect()).toThrowError(expect.objectContaining({ code: "unsafe-state" }));
    await expect(store.mutate(null, async (tx) => tx.publish(empty))).rejects.toMatchObject({
      code: "unsafe-state",
    });
    expect(lstatSync(root).mode & 0o7777).toBe(0o755);
    chmodSync(root, 0o700);
    expect(() =>
      new NativeRecordStore({ root, uid: process.getuid!() + 1 }).inspect(),
    ).toThrowError(expect.objectContaining({ code: "unsafe-state" }));
  });
  it("rejects unsafe files, symlinks and FIFOs without modifying their targets", async () => {
    const { dir, root, path, store } = fixture();
    mkdirSync(root, { mode: 0o700 });
    privateFile(path, JSON.stringify({ ...empty, revision: id }));
    chmodSync(path, 0o644);
    expect(() => store.inspect()).toThrowError(expect.objectContaining({ code: "unsafe-state" }));
    rmSync(path);
    const target = join(dir, "target");
    privateFile(target, "preserved");
    symlinkSync(target, path);
    await expect(store.mutate(null, async (tx) => tx.publish(empty))).rejects.toMatchObject({
      code: "unsafe-state",
    });
    expect(readFileSync(target, "utf8")).toBe("preserved");
    rmSync(path);
    execFileSync("mkfifo", [path]);
    expect(() => store.inspect()).toThrowError(expect.objectContaining({ code: "unsafe-state" }));
  });
  it("rejects a symlink root before creating or replacing state", async () => {
    const { dir, root, store } = fixture();
    const target = join(dir, "private");
    mkdirSync(target, { mode: 0o700 });
    symlinkSync(target, root);
    expect(() => store.inspect()).toThrowError(expect.objectContaining({ code: "unsafe-state" }));
    await expect(store.mutate(null, async (tx) => tx.publish(empty))).rejects.toMatchObject({
      code: "unsafe-state",
    });
    expect(readdirSync(target)).toEqual([]);
  });
  it("rejects unsafe guard metadata while preserving the other owner's marker", async () => {
    const { dir, root, path, store } = fixture();
    mkdirSync(root, { mode: 0o700 });
    const target = join(dir, "guard-target");
    mkdirSync(target, { mode: 0o700 });
    privateFile(join(target, "keep"), "keep");
    symlinkSync(target, `${path}.lock`);
    await expect(store.mutate(null, async (tx) => tx.publish(empty))).rejects.toMatchObject({
      code: "unsafe-state",
    });
    expect(readFileSync(join(target, "keep"), "utf8")).toBe("keep");
    rmSync(`${path}.lock`);
    mkdirSync(`${path}.lock`, { mode: 0o700 });
    const marker = join(`${path}.lock`, `owner-${process.pid}-${id}`);
    privateFile(marker, "");
    chmodSync(marker, 0o644);
    await expect(store.mutate(null, async (tx) => tx.publish(empty))).rejects.toMatchObject({
      code: "unsafe-state",
    });
    expect(existsSync(marker)).toBe(true);
  });
  it("refuses publication after the root or current record changes during an await", async () => {
    const { dir, root, path, store } = fixture();
    const saved = await store.mutate(null, async (tx) => tx.publish(empty));
    await expect(
      store.mutate(saved.revision, async (tx) => {
        privateFile(path, JSON.stringify({ ...empty, revision: id }));
        tx.publish(empty);
      }),
    ).rejects.toMatchObject({ code: "unsafe-state" });
    expect(JSON.parse(readFileSync(path, "utf8")).revision).toBe(id);
    await expect(
      store.mutate(id, async (tx) => {
        renameSync(root, join(dir, "old"));
        mkdirSync(root, { mode: 0o700 });
        tx.publish(empty);
      }),
    ).rejects.toMatchObject({ code: "unsafe-state" });
    expect(readdirSync(root)).toEqual([]);
  });
  it("invalidates escaped transactions and does not trust caller-mutated snapshots", async () => {
    const { store } = fixture();
    let escaped!: NativeRecordTransaction;
    const saved = await store.mutate(null, async (tx) => {
      escaped = tx;
      const record = tx.publish(empty);
      record.revision = id;
      return tx.current;
    });
    expect(saved?.revision).not.toBe(id);
    expect(() => escaped.publish(empty)).toThrowError(
      expect.objectContaining({ code: "operation-failed" }),
    );
    expect(store.inspect()).toEqual(saved);
  });
  it("rejects an invalid publication without losing a previously saved record", async () => {
    const { store } = fixture();
    const saved = await store.mutate(null, async (tx) => tx.publish(empty));
    await expect(
      store.mutate(saved.revision, async (tx) =>
        tx.publish({
          ...empty,
          transition: {
            id,
            action: "start",
            phase: "prepared",
            source: null,
            destination: null,
            recoveryId: id,
          },
        }),
      ),
    ).rejects.toMatchObject({ code: "unsafe-state" });
    expect(store.inspect()).toEqual(saved);
  });
});
