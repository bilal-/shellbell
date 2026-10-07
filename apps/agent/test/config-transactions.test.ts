import { spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as config from "../src/config.js";
import { configRevision } from "../src/config-values.js";
import { initializeLinuxHost } from "../src/host-init.js";
import { resolveLinuxPaths } from "../src/host-paths.js";
import { inspectLinuxState } from "../src/host-state.js";
import { fixture as linuxFixture } from "./host-fixtures.js";

vi.mock("node:fs", async (original) => {
  const fs = await original<typeof import("node:fs")>();
  return { ...fs, lstatSync: vi.fn(fs.lstatSync) };
});
const roots: string[] = [];
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "sb-config-edit-"));
  roots.push(root);
  return config.paths(join(root, "state"));
}
afterEach(() => {
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
function child(dir: string, op: string) {
  const result = spawnSync(
    process.execPath,
    ["--import", "tsx", "test/fakes/config-edit-child.ts", dir, op],
    {
      encoding: "utf8",
      timeout: 10_000,
      env: { ...process.env, SHELLBELL_LIVE: "", SHELLBELL_TMUX_E2E: "" },
    },
  );
  expect(result.error).toBeUndefined();
  expect(result.status, result.stderr).toBe(0);
  return JSON.parse(result.stdout);
}
describe("cooperative configuration transactions", () => {
  it("hashes normalized values in canonical order with a fixed published vector", () => {
    const cfg = {
      v: 1 as const,
      relayUrl: "wss://relay.example",
      computerName: "Fixture",
      accent: "emerald",
      notifyMinCommandMs: 10000,
      idleQuietMs: 4000,
      idleMinActiveMs: 1500,
    };
    expect(configRevision(cfg)).toBe(
      "79417a9c7d2f1d7bf34ef0b4a3fd2aa346d1ab3dfde822eca0ffcfa7e144e638",
    );
    expect(configRevision({ ...cfg })).toBe(configRevision(cfg));
    expect(configRevision({ ...cfg, terminalPlugins: [] })).toBe(configRevision(cfg));
    expect(configRevision({ ...cfg, terminalPlugins: ["/adapters/example.mjs"] })).not.toBe(
      configRevision(cfg),
    );
    expect(configRevision({ ...cfg, relayUrl: "wss://different.invalid" })).not.toBe(
      configRevision(cfg),
    );
    const { notifyMinCommandMs: _n, idleQuietMs: _q, idleMinActiveMs: _a, ...legacy } = cfg;
    expect(configRevision(legacy as config.AgentConfig)).toBe(configRevision(cfg));
    const p = fixture();
    config.saveConfig(p, cfg);
    writeFileSync(
      p.config,
      JSON.stringify({
        accent: cfg.accent,
        computerName: cfg.computerName,
        relayUrl: cfg.relayUrl,
        v: 1,
      }),
    );
    expect(configRevision(config.readConfig(p))).toBe(configRevision(cfg));
  });
  it("edits absent defaults without readonly inspection creating state", () => {
    const p = fixture();
    const before = config.readConfig(p);
    expect(existsSync(p.config)).toBe(false);
    expect(config.editConfig).toBeTypeOf("function");
    expect(
      config.editConfig(p, (c) => ({ ...c, computerName: "Native fixture" })).computerName,
    ).toBe("Native fixture");
    expect(config.readConfig(p).idleQuietMs).toBe(before.idleQuietMs);
  });
  it("excludes another process and default creation, then composes a later explicit edit", () => {
    const p = fixture();
    config.editConfig(p, (c) => {
      expect(child(p.dir, "edit")).toEqual({ code: "busy" });
      expect(child(p.dir, "load")).toEqual({ code: "busy" });
      expect(existsSync(p.config)).toBe(false);
      return { ...c, computerName: "First writer" };
    });
    expect(child(p.dir, "edit")).toMatchObject({ computerName: "First writer", idleQuietMs: 9876 });
    expect(config.loadConfig(p)).toMatchObject({ computerName: "First writer", idleQuietMs: 9876 });
  });
  it("propagates callback exceptions unchanged and releases the guard without writing", () => {
    const p = fixture();
    const sentinel = new Error("callback sentinel");
    expect(() =>
      config.editConfig(p, () => {
        throw sentinel;
      }),
    ).toThrow(sentinel);
    expect(existsSync(p.config)).toBe(false);
    expect(config.editConfig(p, (c) => c)).toEqual(config.readConfig(p));
  });
  it("bounds reads before JSON parsing and accepts the exact byte cap", () => {
    const p = fixture();
    config.loadConfig(p);
    const text = JSON.stringify(config.readConfig(p));
    writeFileSync(p.config, text.padEnd(65_536));
    expect(config.readConfig(p).v).toBe(1);
    writeFileSync(p.config, text.padEnd(65_537));
    expect(() => config.readConfig(p)).toThrow(expect.objectContaining({ code: "invalid" }));
    expect(() => config.saveConfig(p, config.defaultConfig())).toThrow(
      expect.objectContaining({ code: "invalid" }),
    );
    expect(readFileSync(p.config, "utf8")).toBe(text.padEnd(65_537));
  });
  it("rejects oversized or invalid edits while preserving saved bytes", () => {
    const p = fixture();
    const cfg = config.loadConfig(p);
    const before = readFileSync(p.config);
    expect(() =>
      config.saveConfig(p, { ...cfg, relayUrl: `wss://example.invalid/${"x".repeat(65_536)}` }),
    ).toThrow(expect.objectContaining({ code: "invalid" }));
    expect(() => config.editConfig(p, (c) => ({ ...c, idleQuietMs: 0 }))).toThrow(
      expect.objectContaining({ code: "invalid" }),
    );
    expect(readFileSync(p.config)).toEqual(before);
  });
  it("accepts a write of exactly the configuration byte cap", () => {
    const p = fixture();
    const cfg = config.defaultConfig();
    const baseline = Buffer.byteLength(`${JSON.stringify(cfg, null, 2)}\n`);
    cfg.relayUrl += `/${"x".repeat(65_536 - baseline - 1)}`;
    config.saveConfig(p, cfg);
    expect(readFileSync(p.config).length).toBe(65_536);
    expect(config.readConfig(p)).toEqual(cfg);
  });
  it("reports filesystem publication failures as io and preserves unrelated staging files", () => {
    const p = fixture();
    const cfg = config.loadConfig(p);
    const before = readFileSync(p.config);
    const staging = `${p.config}.tmp-${process.pid}`;
    writeFileSync(staging, "another writer", { mode: 0o600 });
    expect(() => config.saveConfig(p, { ...cfg, computerName: "Unsaved" })).toThrow(
      expect.objectContaining({ code: "io" }),
    );
    expect(readFileSync(p.config)).toEqual(before);
    expect(readFileSync(staging, "utf8")).toBe("another writer");
    rmSync(staging);
    expect(config.editConfig(p, (c) => ({ ...c, computerName: "Retry" })).computerName).toBe(
      "Retry",
    );
  });
  it.each(["invalid", "symlink", "directory", "public", "foreign"])(
    "preserves existing %s configuration",
    (kind) => {
      const p = fixture();
      config.loadConfig(p);
      if (kind === "invalid") writeFileSync(p.config, "{ private invalid");
      if (kind === "public") chmodSync(p.config, 0o644);
      if (kind === "symlink" || kind === "directory") {
        rmSync(p.config);
        if (kind === "directory") mkdirSync(p.config, { mode: 0o700 });
        else symlinkSync(p.identity, p.config);
      }
      if (kind === "foreign") {
        const actual = vi.mocked(lstatSync).getMockImplementation()!;
        vi.mocked(lstatSync).mockImplementation(((path: string) => {
          const stat = actual(path);
          if (path === p.config && stat) stat.uid = Number(stat.uid) + 1;
          return stat;
        }) as typeof lstatSync);
      }
      const before = lstatSync(p.config);
      expect(() => config.editConfig(p, (c) => c)).toThrow(
        expect.objectContaining({ code: kind === "invalid" ? "invalid" : "unsafe" }),
      );
      expect(lstatSync(p.config).ino).toBe(before.ino);
      expect(lstatSync(p.config).mode).toBe(before.mode);
    },
  );
  it.each(["public", "symlink"])("never repairs an unsafe %s state directory", (kind) => {
    const p = fixture();
    if (kind === "public") mkdirSync(p.dir, { mode: 0o755 });
    else {
      const target = join(roots.at(-1)!, "target");
      mkdirSync(target, { mode: 0o700 });
      symlinkSync(target, p.dir);
    }
    const before = lstatSync(p.dir);
    expect(() => config.loadConfig(p)).toThrow(expect.objectContaining({ code: "unsafe" }));
    expect(lstatSync(p.dir).mode).toBe(before.mode);
    expect(lstatSync(p.dir).ino).toBe(before.ino);
  });
  it.each(["symlink", "public", "file"])("refuses an unsafe %s settings guard", (kind) => {
    const p = fixture();
    config.loadConfig(p);
    const guard = `${p.config}.lock`;
    if (kind === "symlink") symlinkSync(p.dir, guard);
    else if (kind === "file") writeFileSync(guard, "preserve guard", { mode: 0o600 });
    else mkdirSync(guard, { mode: 0o755 });
    const before = lstatSync(guard);
    expect(() => config.editConfig(p, (c) => c)).toThrow(
      expect.objectContaining({ code: "unsafe" }),
    );
    expect(lstatSync(guard).ino).toBe(before.ino);
    expect(lstatSync(guard).mode).toBe(before.mode);
  });
  it("rejects overlong configuration paths before creating state", () => {
    const p = fixture();
    p.config = join(p.dir, "a".repeat(4096));
    expect(() => config.editConfig(p, (c) => c)).toThrow(
      expect.objectContaining({ code: "unsafe" }),
    );
    expect(existsSync(p.dir)).toBe(false);
  });
  it("keeps Linux host admission intact and holds the settings guard in its admitted runtime", async () => {
    const p = resolveLinuxPaths(linuxFixture().options);
    expect(() => config.loadConfig(p)).toThrow();
    expect(existsSync(p.dir)).toBe(false);
    await initializeLinuxHost(p, { kind: "new" }, config.defaultConfig());
    const identity = readFileSync(p.identity);
    config.editConfig(p, (c) => {
      expect(inspectLinuxState(p).status).toBe("ready");
      expect(existsSync(`${p.config}.lock`)).toBe(false);
      expect(() => config.saveConfig(p, c)).toThrow(expect.objectContaining({ code: "busy" }));
      return { ...c, computerName: "Linux edited" };
    });
    expect(config.loadConfig(p).computerName).toBe("Linux edited");
    expect(inspectLinuxState(p).status).toBe("ready");
    expect(readFileSync(p.identity)).toEqual(identity);
  });
});
