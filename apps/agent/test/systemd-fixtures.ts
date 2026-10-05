import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, vi } from "vitest";

vi.mock("node:os", async (original) => ({
  ...(await original<typeof import("node:os")>()),
  homedir: () => {
    throw new Error("unexpected default home");
  },
}));
vi.mock("node:net", () => ({
  connect: () => {
    throw new Error("unexpected socket");
  },
}));
vi.mock("ws", () => ({
  default: class {
    constructor() {
      throw new Error("unexpected network");
    }
  },
}));

const roots: string[] = [];
afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

export function systemdFixture() {
  const root = realpathSync(mkdtempSync("/tmp/sbs-"));
  roots.push(root);
  const home = join(root, "home");
  const runtime = join(root, "run");
  for (const dir of [root, home, runtime]) {
    if (dir !== root) mkdirSync(dir, { mode: 0o700 });
    chmodSync(dir, 0o700);
  }
  const machineIdPath = join(root, "machine-id");
  writeFileSync(machineIdPath, "0123456789abcdef0123456789abcdef\n");
  for (const [key, value] of Object.entries({
    HOME: home,
    SHELLBELL_DIR: join(root, "state"),
    XDG_CONFIG_HOME: join(home, ".config"),
    XDG_STATE_HOME: join(home, ".state"),
    XDG_RUNTIME_DIR: runtime,
    DBUS_SESSION_BUS_ADDRESS: "unix:path=/forbidden",
    SHELLBELL_SECRET_TEST_SENTINEL: "secret",
  }))
    vi.stubEnv(key, value);
  const uid = process.getuid!();
  const machineOptions = { uid, euid: uid, machineIdPath };
  const hostOptions = {
    ...machineOptions,
    home,
    env: { XDG_RUNTIME_DIR: runtime },
    runtimeFsType: () => 0x01021994,
  };
  const unitName = `shellbell-${"a".repeat(32)}.service`;
  const configRoot = join(home, ".config");
  const unitDir = join(configRoot, "systemd", "user");
  const location = {
    uid,
    home,
    configRoot,
    unitName,
    unitDir,
    definitionPath: join(unitDir, unitName),
    enablementPath: join(unitDir, "default.target.wants", unitName),
    managerRuntimeRoot: runtime,
  };
  const definition = {
    v: 1 as const,
    machineId: "0123456789abcdef0123456789abcdef",
    nodePath: "/opt/node/bin/node",
    cliPath: "/opt/shellbell/dist/cli.js",
    stateDir: join(root, "state"),
    runtimeRoot: runtime,
    serviceInstance: "550e8400-e29b-41d4-a716-446655440000",
    path: "/opt/node/bin:/usr/local/bin:/usr/bin:/bin",
  };
  return { root, home, runtime, machineOptions, hostOptions, location, definition };
}

export async function unitApi(): Promise<typeof import("../src/systemd-unit.js")> {
  return import("../src/systemd-unit.js").catch(() => ({})) as Promise<
    typeof import("../src/systemd-unit.js")
  >;
}
export async function managerApi(): Promise<typeof import("../src/systemd-manager.js")> {
  return import("../src/systemd-manager.js").catch(() => ({})) as Promise<
    typeof import("../src/systemd-manager.js")
  >;
}

export const shown =
  "LoadState=loaded\nActiveState=active\nSubState=running\nMainPID=123\nUnitFileState=enabled\nFragmentPath=/fixture.service\nDropInPaths=\nNeedDaemonReload=no\nConditionResult=yes\n";

/** Real private state, with all defaults redirected before any production import. */
export async function lifecycleFixture() {
  const f = systemdFixture();
  const { generateIdentity, identityToJson, fingerprint } = await import("@shellbell/protocol");
  const { resolveLinuxPaths } = await import("../src/host-paths.js");
  const { readLinuxMachineIdentity } = await import("../src/host-machine.js");
  const { selectSystemdLocation } = await import("../src/systemd-unit.js");
  const env = { ...process.env };
  const selected = resolveLinuxPaths({ ...f.hostOptions, env });
  const machine = readLinuxMachineIdentity(f.machineOptions);
  const location = selectSystemdLocation({ identity: machine, env, home: f.home });
  mkdirSync(selected.dir, { mode: 0o700 });
  const identity = generateIdentity();
  const files = {
    "identity.json": identityToJson(identity),
    "config.json": {
      v: 1,
      relayUrl: "wss://example.invalid",
      computerName: "Fixture",
      accent: "blue",
      notifyMinCommandMs: 10000,
      idleQuietMs: 4000,
      idleMinActiveMs: 1500,
    },
    "pairings.json": { v: 1, phones: [] },
    "host.json": {
      v: 1,
      hostDigest: machine.hostDigest,
      installationId: "550e8400-e29b-41d4-a716-446655440000",
    },
  };
  for (const [name, value] of Object.entries(files))
    writeFileSync(join(selected.dir, name), JSON.stringify(value), { mode: 0o600 });
  return {
    ...f,
    env,
    selected,
    machine,
    location,
    fp: fingerprint(identity.ed25519.pub),
    definition: { ...f.definition, stateDir: selected.dir },
  };
}
