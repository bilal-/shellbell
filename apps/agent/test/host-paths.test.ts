import { createHash, createHmac } from "node:crypto";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { api, fixture } from "./host-fixtures.js";

vi.mock("node:fs", async (original) => {
  const fs = await original<typeof import("node:fs")>();
  return { ...fs, lstatSync: vi.fn(fs.lstatSync) };
});
afterEach(() => vi.restoreAllMocks());

describe("Linux host selection", () => {
  it("binds decoded OS identity and selects without creating state or runtime", async () => {
    const { options } = fixture();
    const host = await api("host-paths");
    expect(host.resolveLinuxPaths).toBeTypeOf("function");
    const p = host.resolveLinuxPaths(options);
    const digest = createHmac("sha256", "shellbell.local-host-scope.v1")
      .update(Buffer.from("0123456789abcdef0123456789abcdef", "hex"))
      .digest("hex");
    expect(p.linuxHost).toEqual({
      uid: options.uid,
      hostDigest: digest,
      hostScope: digest.slice(0, 32),
    });
    expect(p.dir).toContain(`/shellbell/hosts/${digest.slice(0, 32)}`);
    expect(p.runtimeDir).toContain(createHash("sha256").update(p.dir).digest("hex").slice(0, 32));
    expect(existsSync(p.dir)).toBe(false);
    expect(existsSync(p.runtimeDir)).toBe(false);
  });
  it.each([
    "",
    "0".repeat(32),
    "g".repeat(32),
    "1".repeat(33),
    "1".repeat(257),
    " 0123456789abcdef0123456789abcdef",
  ])("rejects malformed OS identity %j", async (id) => {
    const { options } = fixture();
    writeFileSync(options.machineIdPath, id);
    const host = await api("host-paths");
    expect(host.resolveLinuxPaths).toBeTypeOf("function");
    expect(() => host.resolveLinuxPaths(options)).toThrow();
  });
  it("rejects root, mismatched user and unqualified runtime filesystem", async () => {
    const { options } = fixture();
    const host = await api("host-paths");
    expect(host.resolveLinuxPaths).toBeTypeOf("function");
    for (const patch of [
      { uid: 0, euid: 0 },
      { euid: options.uid + 1 },
      { runtimeFsType: () => 0x6969 },
      { runtimeFsType: () => 0x794c7630 },
    ]) {
      expect(() => host.resolveLinuxPaths({ ...options, ...patch })).toThrow();
    }
  });

  it("separates hosts on shared durable storage and ignores hostname and OS ID case", async () => {
    const f = fixture();
    const host = await api("host-paths");
    const first = host.resolveLinuxPaths(f.options);
    writeFileSync(f.options.machineIdPath, "0123456789ABCDEF0123456789ABCDEF");
    expect(
      host.resolveLinuxPaths({ ...f.options, env: { ...f.options.env, HOSTNAME: "renamed" } }).dir,
    ).toBe(first.dir);
    writeFileSync(f.options.machineIdPath, "1123456789abcdef0123456789abcdef\n");
    const second = host.resolveLinuxPaths(f.options);
    expect(second.dir).not.toBe(first.dir);
    expect(second.runtimeDir).not.toBe(first.runtimeDir);
    expect(existsSync(first.dir)).toBe(false);
  });
  it("ignores relative XDG state but rejects relative explicit state and runtime", async () => {
    const { options } = fixture();
    const host = await api("host-paths");
    const first = host.resolveLinuxPaths(options);
    expect(
      host.resolveLinuxPaths({ ...options, env: { ...options.env, XDG_STATE_HOME: "relative" } })
        .dir,
    ).toBe(first.dir);
    for (const patch of [
      { SHELLBELL_DIR: "relative" },
      { SHELLBELL_DIR: "" },
      { XDG_RUNTIME_DIR: "relative" },
    ])
      expect(() =>
        host.resolveLinuxPaths({ ...options, env: { ...options.env, ...patch } }),
      ).toThrow();
  });
  it("canonicalizes existing ancestors, preserves exact explicit destination and rejects a symlink leaf", async () => {
    const f = fixture();
    const host = await api("host-paths");
    const parent = join(f.root, "parent");
    mkdirSync(parent, { mode: 0o700 });
    const alias = join(f.root, "alias");
    symlinkSync(parent, alias);
    const p = host.resolveLinuxPaths({
      ...f.options,
      env: { ...f.options.env, SHELLBELL_DIR: join(alias, "new", "state") },
    });
    expect(p.dir).toBe(join(realpathSync(parent), "new", "state"));
    expect(() =>
      host.resolveLinuxPaths({ ...f.options, env: { ...f.options.env, SHELLBELL_DIR: alias } }),
    ).toThrow();
  });
  it.each([
    "root-mode",
    "child-mode",
    "root-symlink",
    "child-symlink",
    "foreign-user",
    "entry-symlink",
    "entry-mode",
  ])("preserves and rejects unsafe runtime %s", async (kind) => {
    const f = fixture();
    const host = await api("host-paths");
    const p = host.resolveLinuxPaths(f.options);
    host.prepareLinuxRuntime(p);
    if (kind === "root-mode") chmodSync(f.runtime, 0o755);
    if (kind === "child-mode") chmodSync(p.runtimeDir, 0o755);
    if (kind === "root-symlink" || kind === "child-symlink") {
      const target = kind === "root-symlink" ? f.runtime : p.runtimeDir;
      rmSync(target, { recursive: true });
      symlinkSync(f.root, target);
    }
    if (kind === "entry-symlink") symlinkSync(join(f.root, "missing"), p.pid);
    if (kind === "entry-mode") writeFileSync(p.pid, "42", { mode: 0o644 });
    const opts =
      kind === "foreign-user"
        ? { ...f.options, uid: f.options.uid + 1, euid: f.options.uid + 1 }
        : f.options;
    expect(() => host.resolveLinuxPaths(opts)).toThrow();
    if (kind !== "foreign-user") expect(() => host.prepareLinuxRuntime(p)).toThrow();
  });
  it("prepares only private runtime children and recreates deletion without changing selected identity", async () => {
    const f = fixture();
    const host = await api("host-paths");
    const p = host.resolveLinuxPaths(f.options);
    host.prepareLinuxRuntime(p);
    expect(statSync(p.runtimeDir).mode & 0o7777).toBe(0o700);
    expect(p.sock).toBe(join(p.runtimeDir, "agent.sock"));
    expect(p.pid).toBe(join(p.runtimeDir, "agent.pid"));
    rmSync(p.runtimeDir, { recursive: true });
    const next = host.resolveLinuxPaths(f.options);
    expect(next.dir).toBe(p.dir);
    expect(existsSync(next.runtimeDir)).toBe(false);
    host.prepareLinuxRuntime(next);
    expect(existsSync(next.runtimeDir)).toBe(true);
  });
  it("counts UTF-8 socket bytes and accepts all qualified filesystem facts", async () => {
    const f = fixture();
    const host = await api("host-paths");
    for (const type of [0x01021994, 0xef53, 0x58465342, 0x9123683e])
      expect(
        host.resolveLinuxPaths({ ...f.options, runtimeFsType: () => BigInt(type) }).dir,
      ).toBeTruthy();
    const long = join(f.root, "é".repeat(25));
    mkdirSync(long, { mode: 0o700 });
    expect(() => host.resolveLinuxPaths({ ...f.options, env: { XDG_RUNTIME_DIR: long } })).toThrow(
      /107/,
    );
  });

  it("revalidates filesystem qualification on existing runtime children", async () => {
    const f = fixture();
    const host = await api("host-paths");
    const p = host.resolveLinuxPaths(f.options);
    host.prepareLinuxRuntime(p);
    expect(() =>
      host.resolveLinuxPaths({
        ...f.options,
        runtimeFsType: (path) => (path.endsWith("shellbell") ? 0x6969 : 0x01021994),
      }),
    ).toThrow();
  });

  it("separates two synthetic users on one host and refuses the other user's runtime", async () => {
    const first = fixture();
    const second = fixture();
    const otherUid = second.options.uid + 1;
    const actual = vi.mocked(lstatSync).getMockImplementation()!;
    vi.mocked(lstatSync).mockImplementation((...args) => {
      const st = actual(...args);
      if (String(args[0]).startsWith(second.root))
        return Object.assign(Object.create(Object.getPrototypeOf(st)), st, { uid: otherUid });
      return st;
    });
    const host = await api("host-paths");
    const a = host.resolveLinuxPaths(first.options);
    const b = host.resolveLinuxPaths({ ...second.options, uid: otherUid, euid: otherUid });
    expect(a.linuxHost.hostDigest).toBe(b.linuxHost.hostDigest);
    expect(a.dir).not.toBe(b.dir);
    expect(a.runtimeDir).not.toBe(b.runtimeDir);
    expect(() =>
      host.resolveLinuxPaths({
        ...second.options,
        env: first.options.env,
        uid: otherUid,
        euid: otherUid,
      }),
    ).toThrow();
  });

  it("rejects missing machine identity and runtime without manufacturing either", async () => {
    const f = fixture();
    const host = await api("host-paths");
    expect(() =>
      host.resolveLinuxPaths({ ...f.options, machineIdPath: join(f.root, "missing-id") }),
    ).toThrow(/machine identity/);
    const runtime = join(f.root, "missing-runtime");
    expect(() =>
      host.resolveLinuxPaths({ ...f.options, env: { XDG_RUNTIME_DIR: runtime } }),
    ).toThrow(/runtime/);
    expect(existsSync(runtime)).toBe(false);
  });
});
