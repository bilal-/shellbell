import {
  chmodSync,
  existsSync,
  fstatSync,
  mkdirSync,
  readFileSync,
  readSync,
  renameSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { fingerprint, generateIdentity, identityToJson, toBase64Url } from "@shellbell/protocol";
import { afterEach, expect, it, vi } from "vitest";
import { loadConfig, loadPairings, saveConfig, savePairings } from "../src/config.js";
import { boundedRead } from "../src/host-files.js";
import { loadOrCreateIdentity, readIdentity } from "../src/identity.js";
import { api, config, fixture } from "./host-fixtures.js";

vi.mock("node:fs", async (original) => {
  const fs = await original<typeof import("node:fs")>();
  return {
    ...fs,
    readSync: vi.fn(fs.readSync),
    fstatSync: vi.fn(fs.fstatSync),
    unlinkSync: vi.fn(fs.unlinkSync),
    renameSync: vi.fn(fs.renameSync),
  };
});
vi.mock("../src/host-files.js", async (original) => {
  const files = await original<typeof import("../src/host-files.js")>();
  return { ...files, boundedRead: vi.fn(files.boundedRead) };
});
afterEach(() => vi.restoreAllMocks());

async function ready() {
  const host = await api("host-paths");
  const init = await api("host-init");
  const p = host.resolveLinuxPaths(fixture().options);
  await init.initializeLinuxHost(p, { kind: "new" }, config);
  return p;
}

it("reports absent without creating credentials or runtime", async () => {
  const host = await api("host-paths");
  const state = await api("host-state");
  expect(host.resolveLinuxPaths).toBeTypeOf("function");
  expect(state.inspectLinuxState).toBeTypeOf("function");
  const p = host.resolveLinuxPaths(fixture().options);
  expect(state.inspectLinuxState(p)).toEqual({ status: "absent" });
  expect(existsSync(p.dir)).toBe(false);
  expect(existsSync(p.runtimeDir)).toBe(false);
});

it.each(["identity", "config", "pairings"] as const)(
  "rejects missing %s without regeneration through every reader",
  async (name) => {
    const p = await ready();
    const before = readFileSync(p.identity);
    rmSync(p[name]);
    const state = await api("host-state");
    expect(state.inspectLinuxState(p).status).toBe("invalid");
    for (const read of [
      state.readLinuxIdentity,
      state.readLinuxConfig,
      state.readLinuxPairings,
      loadOrCreateIdentity,
      loadConfig,
      loadPairings,
    ])
      expect(() => read(p)).toThrow();
    expect(existsSync(p[name])).toBe(false);
    if (name !== "identity") expect(readFileSync(p.identity)).toEqual(before);
  },
);

it.each(["ed25519", "x25519"] as const)(
  "rejects independent %s public/private inconsistency",
  async (key) => {
    const p = await ready();
    const json = JSON.parse(readFileSync(p.identity, "utf8"));
    json[key].pub = identityToJson(generateIdentity())[key].pub;
    writeFileSync(p.identity, JSON.stringify(json));
    const state = await api("host-state");
    expect(state.inspectLinuxState(p).status).toBe("invalid");
    expect(() => loadOrCreateIdentity(p)).toThrow();
    expect(JSON.parse(readFileSync(p.identity, "utf8"))[key].pub).toBe(json[key].pub);
  },
);

it.each([false, true])(
  "admits a private ownership candidate during its creation or after a crash (marker=%s)",
  async (withMarker) => {
    const p = await ready();
    const state = await api("host-state");
    const token = "123-00000000-0000-4000-8000-000000000001";
    const candidate = join(p.dir, `service-owner.json.lock-candidate-${token}`);
    mkdirSync(candidate, { mode: 0o700 });
    if (withMarker) writeFileSync(join(candidate, `owner-${token}`), "", { mode: 0o600 });
    const before = readFileSync(p.identity);
    expect(state.inspectLinuxState(p).status).toBe("ready");
    expect(() => state.readLinuxIdentity(p)).not.toThrow();
    expect(readFileSync(p.identity)).toEqual(before);
    const { ServiceOwnerStore } = await import("../src/service-ownership.js");
    await new ServiceOwnerStore({ stateDir: p.dir, uid: p.linuxHost.uid }).mutate(
      null,
      async () => {
        expect(state.inspectLinuxState(p).status).toBe("ready");
      },
    );
  },
);

it("does not let a stale reaper move a replacement owner's live guard", async () => {
  const p = await ready();
  const state = await api("host-state");
  const { ServiceOwnerStore } = await import("../src/service-ownership.js");
  const fs = await vi.importActual<typeof import("node:fs")>("node:fs");
  const guard = join(p.dir, "service-owner.json.lock");
  const oldMarker = "owner-2147483647-00000000-0000-4000-8000-000000000001";
  mkdirSync(guard, { mode: 0o700 });
  writeFileSync(join(guard, oldMarker), "", { mode: 0o600 });
  let release!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  let contender: Promise<unknown> | undefined;
  let injected = false;
  let replacementMarker: string | undefined;
  vi.mocked(renameSync).mockImplementation((from, to) => {
    if (!injected && String(from) === guard && String(to).endsWith(oldMarker.slice(6))) {
      injected = true;
      contender = new ServiceOwnerStore({ stateDir: p.dir, uid: p.linuxHost.uid }).mutate(
        null,
        async () => {
          replacementMarker = fs.readdirSync(guard)[0];
          await held;
        },
      );
    }
    fs.renameSync(from, to);
  });
  try {
    const effect = vi.fn();
    await expect(
      new ServiceOwnerStore({ stateDir: p.dir, uid: p.linuxHost.uid }).mutate(null, effect),
    ).rejects.toThrow();
    expect(injected).toBe(true);
    expect(effect).not.toHaveBeenCalled();
    expect(fs.readdirSync(guard)).toEqual([replacementMarker]);
    expect(state.inspectLinuxState(p).status).toBe("ready");
    const third = vi.fn();
    await expect(
      new ServiceOwnerStore({ stateDir: p.dir, uid: p.linuxHost.uid }).mutate(null, third),
    ).rejects.toMatchObject({ code: "busy" });
    expect(third).not.toHaveBeenCalled();
  } finally {
    vi.mocked(renameSync).mockImplementation(fs.renameSync);
    release();
    await contender;
  }
});

it("keeps credentials readable while an owned guard is being removed", async () => {
  const p = await ready();
  const state = await api("host-state");
  const { ServiceOwnerStore } = await import("../src/service-ownership.js");
  const fs = await vi.importActual<typeof import("node:fs")>("node:fs");
  const observations: string[] = [];
  vi.mocked(unlinkSync).mockImplementation((path) => {
    fs.unlinkSync(path);
    if (String(path).startsWith(join(p.dir, "service-owner.json.lock")))
      observations.push(state.inspectLinuxState(p).status);
  });
  try {
    await new ServiceOwnerStore({ stateDir: p.dir, uid: p.linuxHost.uid }).mutate(
      null,
      async () => {},
    );
    expect(observations).toEqual(["ready"]);
    expect(state.inspectLinuxState(p).status).toBe("ready");
  } finally {
    vi.mocked(unlinkSync).mockImplementation(fs.unlinkSync);
  }
});

it.each(["symlink", "mode", "extra", "marker-mode", "wrong-marker", "bad-name"])(
  "refuses an unsafe ownership candidate: %s",
  async (kind) => {
    const p = await ready();
    const state = await api("host-state");
    const token = "123-00000000-0000-4000-8000-000000000001";
    const candidate = join(
      p.dir,
      `service-owner.json.lock-candidate-${kind === "bad-name" ? "invalid" : token}`,
    );
    if (kind === "symlink") symlinkSync(p.dir, candidate);
    else {
      mkdirSync(candidate, { mode: kind === "mode" ? 0o755 : 0o700 });
      if (kind !== "mode" && kind !== "bad-name") {
        writeFileSync(
          join(
            candidate,
            `owner-${kind === "wrong-marker" ? "456-00000000-0000-4000-8000-000000000002" : token}`,
          ),
          "",
          { mode: kind === "marker-mode" ? 0o644 : 0o600 },
        );
        if (kind === "extra") writeFileSync(join(candidate, "extra"), "", { mode: 0o600 });
      }
    }
    expect(state.inspectLinuxState(p).status).toBe("unsafe");
  },
);

it("admits credentials while the private service ownership transaction is held", async () => {
  const p = await ready();
  const { ServiceOwnerStore } = await import("../src/service-ownership.js");
  const state = await api("host-state");
  const before = readFileSync(p.identity);
  await new ServiceOwnerStore({ stateDir: p.dir, uid: p.linuxHost.uid }).mutate(null, async () => {
    expect(state.inspectLinuxState(p).status).toBe("ready");
    expect(() => state.readLinuxIdentity(p)).not.toThrow();
  });
  expect(readFileSync(p.identity)).toEqual(before);
});

it.each(["empty", "extra", "permissive", "symlink"])(
  "rejects unsafe ownership guard %s",
  async (kind) => {
    const p = await ready();
    const state = await api("host-state");
    const guard = join(p.dir, "service-owner.json.lock");
    if (kind === "symlink") symlinkSync(p.dir, guard);
    else {
      mkdirSync(guard, { mode: 0o700 });
      if (kind !== "empty") {
        const marker = join(guard, "owner-123-00000000-0000-4000-8000-000000000001");
        writeFileSync(marker, "", { mode: kind === "permissive" ? 0o644 : 0o600 });
        if (kind === "extra") writeFileSync(join(guard, "extra"), "", { mode: 0o600 });
      }
    }
    expect(state.inspectLinuxState(p).status).toBe("unsafe");
  },
);

it.each(["directory-mode", "file-mode", "file-symlink", "marker-symlink", "foreign-user"])(
  "rejects and preserves unsafe %s",
  async (kind) => {
    const p = await ready();
    const state = await api("host-state");
    if (kind === "directory-mode") chmodSync(p.dir, 0o755);
    if (kind === "file-mode") chmodSync(p.config, 0o644);
    if (kind === "foreign-user") p.linuxHost.uid++;
    if (kind.endsWith("symlink")) {
      const path = kind === "file-symlink" ? p.identity : join(p.dir, "host.json");
      rmSync(path);
      symlinkSync(p.config, path);
    }
    expect(state.inspectLinuxState(p).status).toBe("unsafe");
    expect(() => saveConfig(p, config)).toThrow();
  },
);

it("distinguishes unmarked, wrong-host, malformed and extra-field markers without leaking content", async () => {
  const p = await ready();
  const state = await api("host-state");
  const marker = join(p.dir, "host.json");
  const valid = JSON.parse(readFileSync(marker, "utf8"));
  writeFileSync(marker, JSON.stringify({ ...valid, hostDigest: "a".repeat(64) }));
  expect(state.inspectLinuxState(p).status).toBe("wrong-host");
  writeFileSync(marker, JSON.stringify({ ...valid, PRIVATE_SENTINEL: true }));
  expect(state.inspectLinuxState(p).status).toBe("invalid");
  writeFileSync(marker, "PRIVATE_SENTINEL");
  expect(JSON.stringify(state.inspectLinuxState(p))).not.toContain("PRIVATE_SENTINEL");
  rmSync(marker);
  expect(state.inspectLinuxState(p).status).toBe("unmarked");
});

it.each([
  ["identity", 65536],
  ["config", 65536],
  ["pairings", 1048576],
  ["marker", 4096],
] as const)("accepts exact %s read bound and rejects one byte over", async (name, limit) => {
  const p = await ready();
  const state = await api("host-state");
  const path = name === "marker" ? join(p.dir, "host.json") : p[name];
  const text = readFileSync(path, "utf8");
  writeFileSync(path, text.padEnd(limit, " "));
  expect(state.inspectLinuxState(p).status).toBe("ready");
  writeFileSync(path, text.padEnd(limit + 1, " "));
  expect(state.inspectLinuxState(p).status).toBe("invalid");
});

it("rejects pairing key lengths and fingerprint disagreement while preserving valid pairs", async () => {
  const p = await ready();
  const phone = generateIdentity();
  const pair = {
    phoneFp: fingerprint(phone.ed25519.pub),
    name: "Phone",
    platform: "ios" as const,
    ed25519Pub: toBase64Url(phone.ed25519.pub),
    x25519Pub: toBase64Url(phone.x25519.pub),
    kPair: toBase64Url(new Uint8Array(32)),
    pairedAt: "now",
    lastSeenAt: null,
  };
  savePairings(p, [pair]);
  expect(loadPairings(p)).toEqual([pair]);
  const state = await api("host-state");
  for (const bad of [
    { ...pair, ed25519Pub: "AA" },
    { ...pair, x25519Pub: "AA" },
    { ...pair, kPair: "AA" },
    { ...pair, phoneFp: "a".repeat(26) },
  ]) {
    writeFileSync(p.pairings, JSON.stringify({ v: 1, phones: [bad] }));
    expect(state.inspectLinuxState(p).status).toBe("invalid");
  }
});

it("rejects descriptor replacement before reading credential bytes", async () => {
  const p = await ready();
  const actual = vi.mocked(fstatSync).getMockImplementation()!;
  vi.mocked(readSync).mockClear();
  vi.mocked(fstatSync).mockImplementationOnce((...args) => {
    const st = actual(...args);
    return Object.assign(Object.create(Object.getPrototypeOf(st)), st, { ino: Number(st.ino) + 1 });
  });
  expect(() => boundedRead(p.identity, 65536, p.linuxHost.uid)).toThrow();
  expect(vi.mocked(readSync)).not.toHaveBeenCalled();
});

it("rejects oversized replacement config and pairings without damaging ready state", async () => {
  const p = await ready();
  const before = readFileSync(p.config);
  expect(() =>
    saveConfig(p, { ...config, relayUrl: `wss://example.invalid/${"a".repeat(65536)}` }),
  ).toThrow();
  expect(readFileSync(p.config)).toEqual(before);
  const phone = generateIdentity();
  const pair = {
    phoneFp: fingerprint(phone.ed25519.pub),
    name: "Phone",
    platform: "ios" as const,
    ed25519Pub: toBase64Url(phone.ed25519.pub),
    x25519Pub: toBase64Url(phone.x25519.pub),
    kPair: toBase64Url(new Uint8Array(32)),
    pairedAt: "a".repeat(1048576),
    lastSeenAt: null,
  };
  expect(() => savePairings(p, [pair])).toThrow();
  expect(loadPairings(p)).toEqual([]);
});

it("rejects unexpected descriptor EOF rather than returning truncated bytes", async () => {
  const p = await ready();
  vi.mocked(readSync).mockImplementationOnce(() => 0);
  expect(() => boundedRead(p.config, 65536, p.linuxHost.uid)).toThrow();
});

it.each(["symlink", "directory", "permissive-log"])(
  "rejects unsafe extra destination %s before activation",
  async (kind) => {
    const p = await ready();
    if (kind === "symlink") symlinkSync(p.identity, p.log);
    if (kind === "directory") mkdirSync(join(p.dir, "extra"), { mode: 0o700 });
    if (kind === "permissive-log") writeFileSync(p.log, "log", { mode: 0o644 });
    const state = await api("host-state");
    expect(state.inspectLinuxState(p).status).toBe("unsafe");
    expect(() => loadOrCreateIdentity(p)).toThrow();
  },
);

it("accepts private regular extra destination files without parsing them", async () => {
  const p = await ready();
  writeFileSync(join(p.dir, "operator-note"), "not JSON", { mode: 0o600 });
  const state = await api("host-state");
  expect(state.inspectLinuxState(p).status).toBe("ready");
});

it("does not use prior admission to read a replacement wrong-host directory", async () => {
  const p = await ready();
  const replacement = await ready();
  const marker = join(replacement.dir, "host.json");
  const value = JSON.parse(readFileSync(marker, "utf8"));
  writeFileSync(marker, JSON.stringify({ ...value, hostDigest: "a".repeat(64) }));
  const original = vi.mocked(boundedRead).getMockImplementation()!;
  let markerReads = 0;
  vi.mocked(boundedRead).mockImplementation((...args) => {
    const bytes = original(...args);
    if (args[0] === join(p.dir, "host.json") && ++markerReads === 2) {
      renameSync(p.dir, `${p.dir}.old`);
      renameSync(replacement.dir, p.dir);
    }
    return bytes;
  });
  const state = await api("host-state");
  expect(() => state.readLinuxIdentity(p)).toThrow();
});

it("legacy storage entry points reject absent Linux state without side effects", async () => {
  const host = await api("host-paths");
  const p = host.resolveLinuxPaths(fixture().options);
  for (const action of [
    () => loadConfig(p),
    () => loadPairings(p),
    () => loadOrCreateIdentity(p),
    () => readIdentity(p),
    () => saveConfig(p, config),
    () => savePairings(p, []),
  ]) {
    expect(action).toThrow();
    expect(existsSync(p.dir)).toBe(false);
  }
});
