import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  statSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
  writeSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  DEFAULT_RELAY,
  loadConfig,
  loadPairings,
  paths,
  readConfig,
  saveConfig,
  savePairings,
  writeSecretFile,
} from "../src/config.js";
import { loadOrCreateIdentity } from "../src/identity.js";
import { PairingSchema } from "../src/state-schema.js";

const tmp = () => paths(mkdtempSync(join(tmpdir(), "sb-")));

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return { ...actual, writeSync: vi.fn(actual.writeSync) };
});

describe("config", () => {
  it("readConfig returns unchanged defaults without creating state", () => {
    const p = paths(join(mkdtempSync(join(tmpdir(), "sb-")), "missing"));

    expect(readConfig(p)).toMatchObject({
      v: 1,
      relayUrl: DEFAULT_RELAY,
      notifyMinCommandMs: 10_000,
      idleQuietMs: 30_000,
      idleMinActiveMs: 1_500,
    });
    expect(existsSync(p.dir)).toBe(false);
    expect(existsSync(p.config)).toBe(false);
  });

  it("creates defaults with 0600/0700 modes", () => {
    const p = tmp();
    const cfg = loadConfig(p);
    expect(cfg.relayUrl).toBe(DEFAULT_RELAY);
    expect(cfg.computerName.length).toBeGreaterThan(0);
    expect(cfg.notifyMinCommandMs).toBe(10000);
    expect(statSync(p.config).mode & 0o777).toBe(0o600);
    expect(statSync(p.dir).mode & 0o777).toBe(0o700);
  });
  it("round-trips edits", () => {
    const p = tmp();
    const cfg = loadConfig(p);
    saveConfig(p, { ...cfg, relayUrl: "wss://x.example", accent: "rose" });
    expect(loadConfig(p)).toMatchObject({ relayUrl: "wss://x.example", accent: "rose" });
  });
  it("pairings persist", () => {
    const p = tmp();
    expect(loadPairings(p)).toEqual([]);
    savePairings(p, [
      {
        phoneFp: "a".repeat(26),
        name: "iPhone",
        platform: "ios",
        ed25519Pub: "AA",
        x25519Pub: "BB",
        kPair: "CC",
        pairedAt: "2026-01-01T00:00:00Z",
        lastSeenAt: null,
      },
    ]);
    expect(loadPairings(p)[0]?.name).toBe("iPhone");
    expect(JSON.parse(readFileSync(p.pairings, "utf8")).v).toBe(1);
    const legacy = loadPairings(p)[0];
    expect(legacy?.minProtocolVersion).toBeUndefined();
    expect(PairingSchema.safeParse({ ...legacy, minProtocolVersion: 1 }).success).toBe(false);
    expect(PairingSchema.safeParse({ ...legacy, minProtocolVersion: 3 }).success).toBe(false);
    savePairings(p, [{ ...legacy!, minProtocolVersion: 2 }]);
    expect(loadPairings(p)[0]?.minProtocolVersion).toBe(2);
    const merged = savePairings(p, [legacy!]);
    expect(merged[0]?.minProtocolVersion).toBe(2);
    expect(loadPairings(p)[0]?.minProtocolVersion).toBe(2);
    savePairings(p, [{ ...legacy!, kPair: "NEW" }]);
    expect(loadPairings(p)[0]?.minProtocolVersion).toBeUndefined();
  });
  it("writeSecretFile is atomic: no leftover temp file, mode 0600", () => {
    const p = tmp();
    const file = join(p.dir, "secret.json");
    writeSecretFile(file, "hello\n");
    const leftovers = readdirSync(p.dir).filter((f) => f.includes(".tmp-"));
    expect(leftovers).toEqual([]);
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(readFileSync(file, "utf8")).toBe("hello\n");
  });

  it("checks the destination after staging bytes but before atomic publication", () => {
    const p = tmp();
    const file = join(p.dir, "secret.json");
    const staging = `${file}.tmp-${process.pid}`;
    writeFileSync(file, "original");
    expect(() =>
      writeSecretFile(file, "new content", () => {
        expect(readFileSync(file, "utf8")).toBe("original");
        expect(readFileSync(staging, "utf8")).toBe("new content");
        throw new Error("destination changed");
      }),
    ).toThrow(/destination changed/);
    expect(readFileSync(file, "utf8")).toBe("original");
    expect(existsSync(staging)).toBe(false);
  });

  it.each(["file", "symlink"])("writeSecretFile preserves an unknown staging %s", (kind) => {
    const p = tmp();
    const file = join(p.dir, "secret.json");
    const staging = `${file}.tmp-${process.pid}`;
    const sentinel = kind === "file" ? staging : join(p.dir, "sentinel");
    writeFileSync(file, "original", { mode: 0o640 });
    writeFileSync(sentinel, "untouched", { mode: 0o640 });
    if (kind === "symlink") symlinkSync(sentinel, staging);
    const stagingIdentity = lstatSync(staging);
    const entries = readdirSync(p.dir).sort();
    expect(() => writeSecretFile(file, "replacement")).toThrow(/EEXIST/);
    expect(readFileSync(file, "utf8")).toBe("original");
    expect(statSync(file).mode & 0o777).toBe(0o640);
    expect(readFileSync(sentinel, "utf8")).toBe("untouched");
    expect(statSync(sentinel).mode & 0o777).toBe(0o640);
    expect(lstatSync(staging).ino).toBe(stagingIdentity.ino);
    expect(lstatSync(staging).isSymbolicLink()).toBe(kind === "symlink");
    expect(readdirSync(p.dir).sort()).toEqual(entries);
  });

  it("writeSecretFile removes its owned staging file after a partial write fails", () => {
    const p = tmp();
    const file = join(p.dir, "secret.json");
    writeFileSync(file, "original", { mode: 0o640 });
    const actualWrite = vi.mocked(writeSync).getMockImplementation()!;
    vi.mocked(writeSync).mockImplementationOnce((fd) => {
      actualWrite(fd, "partial");
      throw new Error("write failed");
    });
    expect(() => writeSecretFile(file, "replacement")).toThrow(/write failed/);
    expect(readFileSync(file, "utf8")).toBe("original");
    expect(statSync(file).mode & 0o777).toBe(0o640);
    expect(readdirSync(p.dir)).toEqual(["secret.json"]);
  });

  it("preserves a staging file replaced by another writer after creation", () => {
    const p = tmp();
    const file = join(p.dir, "secret.json");
    const staging = `${file}.tmp-${process.pid}`;
    vi.mocked(writeSync).mockImplementationOnce(() => {
      unlinkSync(staging);
      writeFileSync(staging, "other writer");
      throw new Error("write interrupted");
    });
    expect(() => writeSecretFile(file, "replacement")).toThrow(/write interrupted/);
    expect(readFileSync(staging, "utf8")).toBe("other writer");
  });

  it("writeSecretFile removes its owned staging file after rename fails", () => {
    const p = tmp();
    const file = join(p.dir, "secret.json");
    mkdirSync(file);
    writeFileSync(join(file, "keep"), "original");
    expect(() => writeSecretFile(file, "replacement")).toThrow();
    expect(readFileSync(join(file, "keep"), "utf8")).toBe("original");
    expect(readdirSync(p.dir)).toEqual(["secret.json"]);
  });

  it("writes binary bytes exactly, including NUL and invalid UTF-8", () => {
    const p = tmp();
    const file = join(p.dir, "binary.plist");
    const bytes = Buffer.from([0x62, 0x70, 0x6c, 0x69, 0x73, 0x74, 0, 0xff, 0x80]);
    writeSecretFile(file, bytes);
    expect(readFileSync(file)).toEqual(bytes);
    expect(statSync(file).mode & 0o777).toBe(0o600);
  });

  it("continues after a partial write without losing bytes", () => {
    const p = tmp();
    const file = join(p.dir, "binary.plist");
    const bytes = Buffer.from([0, 1, 2, 3, 0xff]);
    const actualWrite = vi.mocked(writeSync).getMockImplementation()!;
    const partialWrite = (fd: number, data: Uint8Array, offset: number, _length: number) =>
      (
        actualWrite as unknown as (
          fd: number,
          data: Uint8Array,
          offset: number,
          length: number,
        ) => number
      )(fd, data, offset, 2);
    vi.mocked(writeSync).mockImplementationOnce(partialWrite as typeof writeSync);
    writeSecretFile(file, bytes);
    expect(readFileSync(file)).toEqual(bytes);
  });

  it("rejects zero-progress writes and keeps the original target", () => {
    const p = tmp();
    const file = join(p.dir, "binary.plist");
    writeFileSync(file, "original");
    vi.mocked(writeSync).mockImplementationOnce(() => 0);
    expect(() => writeSecretFile(file, Buffer.from([0, 0xff]))).toThrow(/progress/);
    expect(readFileSync(file, "utf8")).toBe("original");
    expect(readdirSync(p.dir)).toEqual(["binary.plist"]);
  });
  it("loadConfig throws a diagnostic error naming the path on invalid JSON", () => {
    const p = tmp();
    loadConfig(p);
    writeFileSync(p.config, "{ not json");
    expect(() => loadConfig(p)).toThrow(p.config);
  });
  it("invalid JSON diagnostics never include file contents", () => {
    const p = tmp();
    loadConfig(p);
    writeFileSync(p.config, "PRIVATE_SENTINEL_CONFIG_CONTENT");

    let message = "";
    try {
      loadConfig(p);
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toContain(p.config);
    expect(message).toContain("not valid JSON");
    expect(message).not.toContain("PRIVATE_");
  });
  it("loadConfig throws a diagnostic error naming the path on a schema mismatch", () => {
    const p = tmp();
    loadConfig(p);
    writeFileSync(p.config, JSON.stringify({ v: 2 }));
    expect(() => loadConfig(p)).toThrow(p.config);
  });
  it("loadPairings throws a diagnostic error naming the path on invalid JSON", () => {
    const p = tmp();
    loadPairings(p);
    writeFileSync(p.pairings, "{ not json");
    expect(() => loadPairings(p)).toThrow(p.pairings);
  });
});

describe("identity", () => {
  it("creates once and reloads the same fingerprint", () => {
    const p = tmp();
    const a = loadOrCreateIdentity(p);
    const b = loadOrCreateIdentity(p);
    expect(a.fp).toBe(b.fp);
    expect(statSync(p.identity).mode & 0o777).toBe(0o600);
  });
  it("throws a diagnostic error naming the path on a corrupt identity file", () => {
    const p = tmp();
    loadOrCreateIdentity(p);
    writeFileSync(p.identity, "{ not json");
    expect(() => loadOrCreateIdentity(p)).toThrow(p.identity);
  });
});
