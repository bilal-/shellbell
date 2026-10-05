import { chmodSync, existsSync, mkdirSync, readdirSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { systemdFixture, unitApi } from "./systemd-fixtures.js";

const foreignOwner = vi.hoisted(() => ({ path: "" }));

vi.mock("../src/host-files.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/host-files.js")>();
  return {
    ...actual,
    optionalStat(path: string) {
      const stat = actual.optionalStat(path);
      if (path === foreignOwner.path && stat) {
        return Object.create(stat, {
          uid: { configurable: true, enumerable: true, value: stat.uid === 0 ? 1 : 0 },
        });
      }
      return stat;
    },
  };
});

vi.mock("node:child_process", () => ({
  spawn: () => {
    throw new Error("unexpected process spawn");
  },
  exec: () => {
    throw new Error("unexpected process exec");
  },
  execFile: () => {
    throw new Error("unexpected process execFile");
  },
  execFileSync: () => {
    throw new Error("unexpected process execFileSync");
  },
}));

describe("owned systemd units", () => {
  it("round trips a strict definition and rejects appended directives", async () => {
    const { definition } = systemdFixture();
    const api = await unitApi();
    expect(api.renderSystemdUnit).toBeTypeOf("function");
    const raw = api.renderSystemdUnit(definition);
    expect(api.parseSystemdUnit(raw)).toEqual(definition);
    expect(raw.toString()).toContain(`ConditionHost=${definition.machineId}`);
    expect(() =>
      api.parseSystemdUnit(Buffer.concat([raw, Buffer.from("Alias=foreign\n")])),
    ).toThrow();
  });
  it("serializes executable tokens separately from environment assignments", async () => {
    const { definition } = systemdFixture();
    const api = await unitApi();
    expect(api.renderSystemdUnit).toBeTypeOf("function");
    definition.nodePath = "/opt/雪 space/$node%/node";
    definition.cliPath = '/opt/雪 space/$cli%"\\/cli.js';
    definition.stateDir = '/state/雪 $literal%"\\';
    const raw = api.renderSystemdUnit(definition).toString();
    expect(raw).toContain(
      'ExecStart=":/opt/雪 space/$node%%/node" "/opt/雪 space/$cli%%\\"\\\\/cli.js" "start" "--service"',
    );
    expect(raw).toContain('Environment="SHELLBELL_DIR=/state/雪 $literal%%\\"\\\\"');
    expect(api.parseSystemdUnit(Buffer.from(raw))).toEqual(definition);
  });
  it.each(["'", '"', "\\"])(
    "rejects Node executable characters systemd v249 refuses: %s",
    async (character) => {
      const { definition } = systemdFixture();
      const api = await unitApi();
      expect(() =>
        api.renderSystemdUnit({ ...definition, nodePath: `/node${character}` }),
      ).toThrow();
    },
  );
  it("accepts canonical owned home/config aliases but rejects descendant directory aliases", async () => {
    const f = systemdFixture();
    const api = await unitApi();
    const identity = {
      uid: f.location.uid,
      machineId: f.definition.machineId,
      hostDigest: "a".repeat(64),
      hostScope: "a".repeat(32),
    };
    const alias = join(f.root, "home-alias");
    symlinkSync(f.home, alias);
    const config = join(f.root, "configuration");
    mkdirSync(config, { mode: 0o700 });
    symlinkSync(config, join(f.home, ".config"));
    const location = api.selectSystemdLocation({ identity, env: {}, home: alias });
    expect(location.home).toBe(f.home);
    expect(location.configRoot).toBe(config);
    symlinkSync(f.runtime, join(config, "systemd"));
    expect(() => api.selectSystemdLocation({ identity, env: {}, home: alias })).toThrow();
  });
  it("rejects unsafe and dangling canonical HOME/XDG config-root aliases without mutation", async () => {
    const f = systemdFixture();
    const api = await unitApi();
    const identity = {
      uid: f.location.uid,
      machineId: f.definition.machineId,
      hostDigest: "a".repeat(64),
      hostScope: "a".repeat(32),
    };
    const reject = (target: string, env: NodeJS.ProcessEnv, home: string, foreign = false) => {
      const before = readdirSync(f.root).sort();
      foreignOwner.path = foreign ? target : "";
      try {
        expect(() => api.selectSystemdLocation({ identity, env, home })).toThrow();
      } finally {
        foreignOwner.path = "";
      }
      expect(readdirSync(f.root).sort()).toEqual(before);
      expect(existsSync(join(target, "systemd"))).toBe(false);
    };

    for (const [root, home] of [
      ["home", ""],
      ["config", f.home],
    ] as const) {
      for (const [label, mode] of [
        ["group-writable", 0o770],
        ["other-writable", 0o707],
      ] as const) {
        const target = join(f.root, `${root}-${label}`);
        const alias = join(f.root, `${root}-${label}-alias`);
        mkdirSync(target, { mode: 0o700 });
        chmodSync(target, mode);
        symlinkSync(target, alias);
        reject(
          target,
          root === "config" ? { XDG_CONFIG_HOME: alias } : {},
          root === "home" ? alias : home,
        );
      }

      const foreignTarget = join(f.root, `${root}-foreign`);
      const foreignAlias = join(f.root, `${root}-foreign-alias`);
      mkdirSync(foreignTarget, { mode: 0o700 });
      symlinkSync(foreignTarget, foreignAlias);
      reject(
        foreignTarget,
        root === "config" ? { XDG_CONFIG_HOME: foreignAlias } : {},
        root === "home" ? foreignAlias : home,
        true,
      );

      const danglingTarget = join(f.root, `${root}-dangling-target`);
      const danglingAlias = join(f.root, `${root}-dangling-alias`);
      symlinkSync(danglingTarget, danglingAlias);
      reject(
        danglingTarget,
        root === "config" ? { XDG_CONFIG_HOME: danglingAlias } : {},
        root === "home" ? danglingAlias : home,
      );
    }
  });

  it("enforces the decoded metadata boundary before accepting the complete unit", async () => {
    const { definition } = systemdFixture();
    const api = await unitApi();
    const overhead = Buffer.byteLength(JSON.stringify({ ...definition, stateDir: "/" }));
    definition.stateDir = `/${"x".repeat(16384 - overhead)}`;
    expect(api.parseSystemdUnit(api.renderSystemdUnit(definition))).toEqual(definition);
    expect(() =>
      api.renderSystemdUnit({ ...definition, stateDir: `${definition.stateDir}x` }),
    ).toThrow();
  });
  it.each(["\n", "\r", "\t", "\0", "\x7f", "\u0085", "\u009f", "\ud800", "\udfff"])(
    "rejects unsafe stored text %j",
    async (bad) => {
      const { definition } = systemdFixture();
      const api = await unitApi();
      expect(api.renderSystemdUnit).toBeTypeOf("function");
      expect(() => api.renderSystemdUnit({ ...definition, stateDir: `/state/${bad}` })).toThrow();
    },
  );
  it("rejects noncanonical metadata, unknown fields, invalid paths, UUIDs and oversized units", async () => {
    const { definition } = systemdFixture();
    const api = await unitApi();
    expect(api.renderSystemdUnit).toBeTypeOf("function");
    for (const patch of [
      { machineId: "0".repeat(32) },
      { machineId: "A".repeat(32) },
      { cliPath: "relative" },
      { serviceInstance: "bad" },
      { path: "/bin:relative" },
      { path: "/bin:/bin" },
      { path: "/bin:" },
      { extra: "bad" },
      { stateDir: `/${"x".repeat(16384)}` },
    ])
      expect(() => api.renderSystemdUnit({ ...definition, ...patch })).toThrow();
    const raw = api.renderSystemdUnit(definition).toString();
    const encoded = raw.split("\n")[0]!.split(" ").at(-1)!;
    for (const replacement of [
      `${encoded}=`,
      Buffer.from(JSON.stringify({ ...definition, extra: true })).toString("base64url"),
      Buffer.from(JSON.stringify(definition, null, 2)).toString("base64url"),
      Buffer.from('{"v":1,"v":1}').toString("base64url"),
    ])
      expect(() => api.parseSystemdUnit(Buffer.from(raw.replace(encoded, replacement)))).toThrow();
    expect(() => api.parseSystemdUnit(Buffer.alloc(65537))).toThrow();
    expect(() =>
      api.parseSystemdUnit(Buffer.from(raw.replace("Type=exec", "Type=simple"))),
    ).toThrow();
  });
  it("shares the existing host digest without exposing OS identity through paths", async () => {
    const f = systemdFixture();
    const machine = (await import("../src/host-machine.js").catch(
      () => ({}),
    )) as typeof import("../src/host-machine.js");
    expect(machine.readLinuxMachineIdentity).toBeTypeOf("function");
    const identity = machine.readLinuxMachineIdentity(f.machineOptions);
    const { resolveLinuxPaths } = await import("../src/host-paths.js");
    const paths = resolveLinuxPaths(f.hostOptions);
    expect(identity.machineId).toBe("0123456789abcdef0123456789abcdef");
    expect(paths.linuxHost.hostDigest).toBe(identity.hostDigest);
    expect(JSON.stringify(paths)).not.toContain(identity.machineId);
    const api = await unitApi();
    const location = api.selectSystemdLocation({
      identity,
      env: { XDG_CONFIG_HOME: "relative" },
      home: f.home,
    });
    expect(location.definitionPath).toBe(
      join(f.home, ".config/systemd/user", `shellbell-${identity.hostScope}.service`),
    );
    expect(location.managerRuntimeRoot).toBe(`/run/user/${identity.uid}`);
    expect(existsSync(location.unitDir)).toBe(false);
  });
  it("rejects unsafe existing unit directories and symlink definitions without repairing them", async () => {
    const f = systemdFixture();
    const api = await unitApi();
    expect(api.selectSystemdLocation).toBeTypeOf("function");
    const identity = {
      uid: f.location.uid,
      machineId: f.definition.machineId,
      hostDigest: "a".repeat(64),
      hostScope: "a".repeat(32),
    };
    mkdirSync(f.location.unitDir, { recursive: true, mode: 0o700 });
    chmodSync(f.location.unitDir, 0o777);
    expect(() => api.selectSystemdLocation({ identity, env: {}, home: f.home })).toThrow();
    chmodSync(f.location.unitDir, 0o700);
    symlinkSync("/foreign", f.location.definitionPath);
    expect(() => api.selectSystemdLocation({ identity, env: {}, home: f.home })).toThrow();
  });
});
