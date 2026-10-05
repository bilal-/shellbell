import { createHash } from "node:crypto";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { generateIdentity, identityToJson } from "@shellbell/protocol";
import { expect, it } from "vitest";
import type { HostInitDependencies, HostInitMode } from "../src/host-init.js";
import type { AgentConfig } from "../src/state-schema.js";
import { api, config, fixture } from "./host-fixtures.js";

it("initializes explicitly once and preserves identity on repeat", async () => {
  const host = await api("host-paths");
  const state = await api("host-state");
  const init = await api("host-init");
  expect(host.resolveLinuxPaths).toBeTypeOf("function");
  expect(init.initializeLinuxHost).toBeTypeOf("function");
  const p = host.resolveLinuxPaths(fixture().options);
  expect(await init.initializeLinuxHost(p, { kind: "new" }, config)).toEqual({
    status: "initialized",
    stateDir: p.dir,
  });
  expect(state.inspectLinuxState(p).status).toBe("ready");
  const bytes = readFileSync(p.identity);
  expect((await init.initializeLinuxHost(p, { kind: "new" }, config)).status).toBe(
    "already-initialized",
  );
  expect(readFileSync(p.identity)).toEqual(bytes);
});

async function adoptionFixture() {
  const f = fixture();
  const source = join(f.root, "source");
  mkdirSync(source, { mode: 0o700 });
  writeFileSync(join(source, "identity.json"), JSON.stringify(identityToJson(generateIdentity())), {
    mode: 0o600,
  });
  writeFileSync(join(source, "config.json"), JSON.stringify(config), { mode: 0o600 });
  writeFileSync(join(source, "pairings.json"), '{"v":1,"phones":[]}', { mode: 0o600 });
  const host = await api("host-paths");
  return { ...f, source, p: host.resolveLinuxPaths(f.options), host };
}

it.each(
  (["source", "runtime"] as const).flatMap((location) =>
    ["agent.sock.lock", "init.sock.lock", "service.lock"].flatMap((guard) =>
      (["live", "ambiguous", "symlink", "dangling-symlink"] as const).map((kind) => ({
        location,
        guard,
        kind,
      })),
    ),
  ),
)(
  "refuses $location $guard preparation candidate ($kind) without changing evidence",
  async ({ location, guard, kind }) => {
    const f = await adoptionFixture();
    let dir = f.source;
    if (location === "runtime") {
      f.host.prepareLinuxRuntime(f.p);
      dir = join(
        f.runtime,
        "shellbell",
        createHash("sha256").update(realpathSync(f.source)).digest("hex").slice(0, 32),
      );
      mkdirSync(dir, { mode: 0o700 });
    }
    const owner = "1234-12345678-1234-4234-8234-123456789abc";
    const candidate = join(
      dir,
      `${guard}-candidate-${kind === "ambiguous" ? "incomplete" : owner}`,
    );
    const target = join(f.root, "candidate-target");
    if (kind === "symlink" || kind === "dangling-symlink") {
      if (kind === "symlink") {
        mkdirSync(target, { mode: 0o700 });
        writeFileSync(join(target, "sentinel"), "preserve candidate target", { mode: 0o600 });
      }
      symlinkSync(target, candidate);
    } else {
      mkdirSync(candidate, { mode: 0o700 });
      if (kind === "live") writeFileSync(join(candidate, `owner-${owner}`), "", { mode: 0o600 });
    }
    const before = lstatSync(candidate);
    const credentials = ["identity.json", "config.json", "pairings.json"].map((name) => ({
      name,
      bytes: readFileSync(join(f.source, name)),
    }));
    const init = await api("host-init");
    await expect(
      init.initializeLinuxHost(
        f.p,
        { kind: "adopt", source: f.source, confirmSourceInactive: true },
        config,
        {
          probeSocket: async () => "absent",
          processAlive: () => {
            if (kind === "live") return true;
            throw new Error("ambiguous synthetic observation");
          },
        },
      ),
    ).rejects.toThrow(/inspect/);
    expect(existsSync(f.p.dir)).toBe(false);
    const after = lstatSync(candidate);
    expect({ dev: after.dev, ino: after.ino, mode: after.mode }).toEqual({
      dev: before.dev,
      ino: before.ino,
      mode: before.mode,
    });
    if (kind === "symlink" || kind === "dangling-symlink")
      expect(readlinkSync(candidate)).toBe(target);
    if (kind === "symlink")
      expect(readFileSync(join(target, "sentinel"), "utf8")).toBe("preserve candidate target");
    if (kind === "live") expect(readFileSync(join(candidate, `owner-${owner}`), "utf8")).toBe("");
    if (kind === "ambiguous") expect(readdirSync(candidate)).toEqual([]);
    for (const { name, bytes } of credentials)
      expect(readFileSync(join(f.source, name))).toEqual(bytes);
  },
);

it.each(["source", "runtime"] as const)(
  "preserves unrelated %s candidate-like artifacts during adoption",
  async (location) => {
    const f = await adoptionFixture();
    let dir = f.source;
    if (location === "runtime") {
      f.host.prepareLinuxRuntime(f.p);
      dir = join(
        f.runtime,
        "shellbell",
        createHash("sha256").update(realpathSync(f.source)).digest("hex").slice(0, 32),
      );
      mkdirSync(dir, { mode: 0o700 });
    }
    const unrelated = join(dir, "operator.lock-candidate-note");
    mkdirSync(unrelated, { mode: 0o700 });
    writeFileSync(join(unrelated, "note"), "keep", { mode: 0o600 });
    const init = await api("host-init");
    expect(
      (
        await init.initializeLinuxHost(
          f.p,
          { kind: "adopt", source: f.source, confirmSourceInactive: true },
          config,
          { probeSocket: async () => "absent", processAlive: () => false },
        )
      ).status,
    ).toBe("initialized");
    expect(readFileSync(join(unrelated, "note"), "utf8")).toBe("keep");
    expect(existsSync(join(f.p.dir, "operator.lock-candidate-note"))).toBe(false);
  },
);

it.each([
  "active-socket",
  "ambiguous-socket",
  "live-pid",
  "ambiguous-pid",
  "bad-pid",
  "guard",
  "runtime-pid",
  "runtime-socket",
  "runtime-symlink",
  "source-mode",
  "source-symlink",
  "file-mode",
  "file-symlink",
  "missing-confirmation",
  "relative-source",
  "same-target",
  "invalid-config",
])("refuses adoption with %s before creating destination", async (kind) => {
  const f = await adoptionFixture();
  const init = await api("host-init");
  const identity = readFileSync(join(f.source, "identity.json"));
  let source = f.source;
  const mode = { kind: "adopt", source, confirmSourceInactive: true };
  const deps: HostInitDependencies = {
    probeSocket: async (_path: string) => "absent",
    processAlive: (_pid: number) => false,
  };
  if (kind === "active-socket") deps.probeSocket = async () => "active";
  if (kind === "ambiguous-socket") deps.probeSocket = async () => "ambiguous";
  if (["live-pid", "ambiguous-pid", "bad-pid"].includes(kind))
    writeFileSync(join(source, "agent.pid"), kind === "bad-pid" ? "corrupt" : "1234\n", {
      mode: 0o600,
    });
  if (kind === "live-pid") deps.processAlive = () => true;
  if (kind === "ambiguous-pid")
    deps.processAlive = () => {
      throw new Error("unknown observation");
    };
  if (kind === "guard") mkdirSync(join(source, "agent.sock.lock"), { mode: 0o700 });
  if (kind.startsWith("runtime-")) {
    f.host.prepareLinuxRuntime(f.p);
    const runtime = join(
      f.runtime,
      "shellbell",
      createHash("sha256").update(realpathSync(source)).digest("hex").slice(0, 32),
    );
    if (kind === "runtime-symlink") symlinkSync(source, runtime);
    else {
      mkdirSync(runtime, { mode: 0o700 });
      if (kind === "runtime-pid") {
        writeFileSync(join(runtime, "agent.pid"), "1234", { mode: 0o600 });
        deps.processAlive = () => true;
      }
      if (kind === "runtime-socket")
        deps.probeSocket = async (path) => (path.startsWith(runtime) ? "active" : "absent");
    }
  }
  if (kind === "source-mode") chmodSync(source, 0o755);
  if (kind === "source-symlink") {
    const alias = join(f.root, "alias");
    symlinkSync(source, alias);
    source = alias;
  }
  if (kind === "file-mode") chmodSync(join(source, "config.json"), 0o644);
  if (kind === "file-symlink") symlinkSync(join(source, "config.json"), join(source, "agent.pid"));
  if (kind === "missing-confirmation") mode.confirmSourceInactive = false;
  if (kind === "relative-source") source = "source";
  if (kind === "same-target") source = f.p.dir;
  if (kind === "invalid-config") writeFileSync(join(source, "config.json"), "PRIVATE_SENTINEL");
  mode.source = source;
  await expect(init.initializeLinuxHost(f.p, mode as HostInitMode, config, deps)).rejects.toThrow(
    /inspect/,
  );
  expect(existsSync(f.p.dir)).toBe(false);
  expect(readFileSync(join(f.source, "identity.json"))).toEqual(identity);
});

it("serializes competing adoption under a local guard and preserves one identity", async () => {
  const f = await adoptionFixture();
  const init = await api("host-init");
  const mode = { kind: "adopt", source: f.source, confirmSourceInactive: true } as const;
  const deps: HostInitDependencies = {
    probeSocket: async () => "absent",
    processAlive: () => false,
  };
  const results = await Promise.allSettled([
    init.initializeLinuxHost(f.p, mode, config, deps),
    init.initializeLinuxHost(f.p, mode, config, deps),
  ]);
  expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
  expect(results.filter((result) => result.status === "rejected")).toHaveLength(1);
  expect(readFileSync(f.p.identity)).toEqual(readFileSync(join(f.source, "identity.json")));
  expect(readdirSync(f.p.runtimeDir)).toEqual([]);
  expect((await init.initializeLinuxHost(f.p, mode, config, deps)).status).toBe(
    "already-initialized",
  );
});

it("does not chmod existing ancestors or preserve an unsafe destination as initialized", async () => {
  const f = fixture();
  const host = await api("host-paths");
  const init = await api("host-init");
  const parent = join(f.root, "parent");
  mkdirSync(parent, { mode: 0o755 });
  chmodSync(parent, 0o755);
  const p = host.resolveLinuxPaths({
    ...f.options,
    env: { ...f.options.env, SHELLBELL_DIR: join(parent, "state") },
  });
  await init.initializeLinuxHost(p, { kind: "new" }, config);
  expect(statSync(parent).mode & 0o7777).toBe(0o755);
  const bytes = readFileSync(p.identity);
  chmodSync(p.dir, 0o755);
  await expect(init.initializeLinuxHost(p, { kind: "new" }, config)).rejects.toThrow();
  expect(readFileSync(p.identity)).toEqual(bytes);
  expect(statSync(p.dir).mode & 0o7777).toBe(0o755);
});

it("rejects new config beyond its admission bound before generating any destination", async () => {
  const f = fixture();
  const host = await api("host-paths");
  const init = await api("host-init");
  const p = host.resolveLinuxPaths(f.options);
  await expect(
    init.initializeLinuxHost(
      p,
      { kind: "new" },
      { ...config, relayUrl: `wss://example.invalid/${"a".repeat(65536)}` },
    ),
  ).rejects.toThrow();
  expect(existsSync(p.dir)).toBe(false);
});

it("refuses a source runtime on an unqualified mounted filesystem", async () => {
  const f = await adoptionFixture();
  f.host.prepareLinuxRuntime(f.p);
  const runtime = join(
    f.runtime,
    "shellbell",
    createHash("sha256").update(realpathSync(f.source)).digest("hex").slice(0, 32),
  );
  mkdirSync(runtime, { mode: 0o700 });
  const p = f.host.resolveLinuxPaths({
    ...f.options,
    runtimeFsType: (path) => (path === runtime ? 0x6969 : 0x01021994),
  });
  const init = await api("host-init");
  await expect(
    init.initializeLinuxHost(
      p,
      { kind: "adopt", source: f.source, confirmSourceInactive: true },
      config,
      { probeSocket: async () => "absent" },
    ),
  ).rejects.toThrow();
  expect(existsSync(p.dir)).toBe(false);
});

it("refuses adoption when legacy IPC pathname cannot be observed within the Unix path limit", async () => {
  const f = await adoptionFixture();
  const source = join(f.root, "s".repeat(100));
  mkdirSync(source, { mode: 0o700 });
  for (const name of ["identity.json", "config.json", "pairings.json"])
    writeFileSync(join(source, name), readFileSync(join(f.source, name)), { mode: 0o600 });
  const init = await api("host-init");
  await expect(
    init.initializeLinuxHost(f.p, { kind: "adopt", source, confirmSourceInactive: true }, config, {
      probeSocket: async () => "absent",
    }),
  ).rejects.toThrow();
  expect(existsSync(f.p.dir)).toBe(false);
});

it("adopts exact bytes without changing source or copying unrelated entries", async () => {
  const f = fixture();
  const source = join(f.root, "source");
  mkdirSync(source, { mode: 0o700 });
  const bytes = {
    "identity.json": ` ${JSON.stringify(identityToJson(generateIdentity()))}\n`,
    "config.json": `\n${JSON.stringify(config)} `,
    "pairings.json": ' {"v":1,"phones":[]}\n',
  };
  for (const [name, text] of Object.entries(bytes))
    writeFileSync(join(source, name), text, { mode: 0o600 });
  writeFileSync(join(source, "agent.log"), "not copied");
  const host = await api("host-paths");
  const init = await api("host-init");
  expect(init.initializeLinuxHost).toBeTypeOf("function");
  const p = host.resolveLinuxPaths(f.options);
  await init.initializeLinuxHost(
    p,
    { kind: "adopt", source, confirmSourceInactive: true },
    { invalid: true } as unknown as AgentConfig,
    { probeSocket: async () => "absent", processAlive: () => false },
  );
  for (const [name, text] of Object.entries(bytes)) {
    expect(readFileSync(join(p.dir, name), "utf8")).toBe(text);
    expect(readFileSync(join(source, name), "utf8")).toBe(text);
  }
  expect(existsSync(p.log)).toBe(false);
});

it.each(
  [
    "before-identity",
    "after-identity",
    "before-config",
    "after-config",
    "before-pairings",
    "after-pairings",
    "before-marker",
    "after-marker",
    "before-directory-fsync",
    "after-directory-fsync",
  ].flatMap((point) => (["new", "adopt"] as const).map((kind) => ({ point, kind }))),
)("preserves $kind state at $point and never rekeys on retry", async ({ point, kind }) => {
  const f = await adoptionFixture();
  const init = await api("host-init");
  const state = await api("host-state");
  expect(init.initializeLinuxHost).toBeTypeOf("function");
  const p = f.p;
  const sourceBytes = ["identity.json", "config.json", "pairings.json"].map((name) => ({
    name,
    bytes: readFileSync(join(f.source, name)),
  }));
  const mode: HostInitMode =
    kind === "new" ? { kind } : { kind, source: f.source, confirmSourceInactive: true };
  const deps: HostInitDependencies = {
    probeSocket: async () => "absent",
    processAlive: () => false,
  };
  await expect(
    init.initializeLinuxHost(p, mode, config, {
      ...deps,
      checkpoint: (at: string) => {
        if (at === point) throw new Error("PRIVATE_SENTINEL");
      },
    }),
  ).rejects.toThrow(/inspect/i);
  expect(existsSync(p.dir)).toBe(true);
  const active = ["after-marker", "before-directory-fsync", "after-directory-fsync"].includes(
    point,
  );
  expect(state.inspectLinuxState(p).status).toBe(active ? "ready" : "unmarked");
  const bytes = existsSync(p.identity) ? readFileSync(p.identity) : undefined;
  if (active)
    expect((await init.initializeLinuxHost(p, mode, config, deps)).status).toBe(
      "already-initialized",
    );
  else await expect(init.initializeLinuxHost(p, mode, config, deps)).rejects.toThrow();
  if (bytes) expect(readFileSync(p.identity)).toEqual(bytes);
  for (const original of sourceBytes)
    expect(readFileSync(join(f.source, original.name))).toEqual(original.bytes);
});
