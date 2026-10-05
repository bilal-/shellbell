import { existsSync, lstatSync, readdirSync, readFileSync, readlinkSync } from "node:fs";
import { join } from "node:path";
import { vi } from "vitest";
import type { LocalStatus } from "../src/local-status.js";
import { type SystemdLifecycleOptions, SystemdServiceLifecycle } from "../src/systemd-lifecycle.js";
import type { SystemdManagerApi, SystemdObservation } from "../src/systemd-manager.js";
import { parseSystemdUnit } from "../src/systemd-unit.js";
import { lifecycleFixture } from "./systemd-fixtures.js";

const hostile = vi.hoisted(() =>
  vi.fn(() => {
    throw new Error("unexpected external boundary");
  }),
);

export { hostile };

vi.mock("node:child_process", () => ({
  spawn: hostile,
  exec: hostile,
  execFile: hostile,
  execFileSync: hostile,
}));
vi.mock("../src/launchd.js", () => ({ createLaunchdManager: hostile }));
vi.mock("../src/backends/registry.js", () => ({
  BACKEND_ORDER: ["iterm2", "tmux", "herdr"],
  BackendRegistry: hostile,
}));
vi.mock("../src/identity.js", async (original) => ({
  ...(await original<typeof import("../src/identity.js")>()),
  loadOrCreateIdentity: hostile,
}));

export function tree(path: string): unknown {
  if (!existsSync(path)) return null;
  const s = lstatSync(path);
  return {
    mode: s.mode,
    content: s.isSymbolicLink()
      ? readlinkSync(path)
      : s.isDirectory()
        ? Object.fromEntries(
            readdirSync(path)
              .sort()
              .map((name) => [name, tree(join(path, name))]),
          )
        : readFileSync(path).toString("base64"),
  };
}

export async function integrationFixture() {
  const f = await lifecycleFixture();
  const calls: string[] = [];
  const observation: SystemdObservation = {
    available: true,
    loadState: "not-found",
    activeState: "inactive",
    subState: "dead",
    mainPid: null,
    unitFileState: "disabled",
    fragmentPath: "",
    dropInPaths: "",
    needDaemonReload: false,
    conditionResult: true,
  };
  let local: LocalStatus | null = null;
  let now = 0;
  let linger: "yes" | "no" | "unknown" = "no";
  let externalEnabled = false;
  const manager: SystemdManagerApi = {
    observe: async () => {
      calls.push("observe");
      return { ...observation };
    },
    linger: async () => {
      calls.push("linger");
      return linger;
    },
    execute: async (verb) => {
      calls.push(verb);
      if (verb === "daemon-reload")
        Object.assign(observation, {
          loadState: existsSync(f.location.definitionPath) ? "loaded" : "not-found",
          fragmentPath: existsSync(f.location.definitionPath) ? f.location.definitionPath : "",
          unitFileState:
            externalEnabled || existsSync(f.location.enablementPath) ? "enabled" : "disabled",
        });
      else if (verb === "start") {
        const def = parseSystemdUnit(readFileSync(f.location.definitionPath));
        Object.assign(observation, { activeState: "active", subState: "running", mainPid: 123 });
        local = {
          controlVersion: 1,
          process: {
            pid: 123,
            agentVersion: "test",
            computerFp: f.fp,
            stateDir: f.selected.dir,
            serviceInstance: def.serviceInstance,
          },
          backends: [
            { name: "iterm2", connected: false },
            { name: "tmux", connected: true },
            { name: "herdr", connected: false },
          ],
          terminalReady: true,
          relayOnline: true,
          sessions: 1,
          phones: [],
          connected: [],
        };
      } else {
        Object.assign(observation, { activeState: "inactive", subState: "dead", mainPid: null });
        local = null;
      }
    },
  };
  const options: SystemdLifecycleOptions = {
    env: f.env,
    home: f.home,
    machine: f.machineOptions,
    manager,
    selectPaths: () => f.selected,
    resolveRuntime: () => ({
      nodePath: "/opt/node/bin/node",
      cliPath: "/opt/shellbell/dist/cli.js",
      packageRoot: "/opt/shellbell",
    }),
    clock: {
      now: () => now,
      sleep: async (ms) => {
        now += ms;
      },
    },
    probe: async () => {
      if (local) return local;
      throw Object.assign(new Error("absent"), { code: "ENOENT" });
    },
  };
  const lifecycle = new SystemdServiceLifecycle(options);
  return {
    ...f,
    calls,
    observation,
    lifecycle,
    options,
    getLocal: () => local,
    setLocal: (value: LocalStatus | null) => {
      local = value;
    },
    setLinger: (value: typeof linger) => {
      linger = value;
    },
    setExternalEnabled: () => {
      externalEnabled = true;
    },
  };
}
