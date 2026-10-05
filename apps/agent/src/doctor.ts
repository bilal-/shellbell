import { execFile } from "node:child_process";
import { accessSync, constants, existsSync } from "node:fs";
import { delimiter, join } from "node:path";
import { promisify } from "node:util";
import { herdrSocketPath, INSTALL_HINT, UPGRADE_HINT } from "./backends/herdr/client.js";
import { checkHerdr, type HerdrCheck } from "./backends/herdr/start.js";
import { DEFAULT_SOCKET } from "./backends/iterm2/client.js";
import { type Paths, readConfig } from "./config.js";
import { controlRequest } from "./control.js";
import { probeRelayHealth } from "./doctor-relay.js";
import { type LinuxPaths, resolveLinuxPaths } from "./host-paths.js";
import { inspectLinuxState } from "./host-state.js";
import { readIdentity } from "./identity.js";
import { createLaunchdManager } from "./launchd.js";
import { type LocalStatus, LocalStatusSchema } from "./local-status.js";
import { selectServicePaths } from "./service-lifecycle.js";
import type { ServiceSnapshot } from "./service-manager.js";
import { matchesLocalService } from "./service-readiness.js";
import { type LinuxServiceStatus, SystemdServiceLifecycle } from "./systemd-lifecycle.js";

const run = promisify(execFile);
type Backend = "iterm2" | "tmux" | "herdr";

export interface Check {
  name: string;
  ok: boolean;
  severity: "pass" | "warning" | "error";
  detail: string;
  fix?: string;
  required?: boolean;
}

export interface DoctorOptions {
  platform?: NodeJS.Platform;
  requestedStateDir?: string;
  defaultStateDir: string;
  requiredBackends: readonly Backend[];
  env: NodeJS.ProcessEnv;
}

export interface RunDoctorDeps {
  selectLinuxPaths?: (env: NodeJS.ProcessEnv) => LinuxPaths;
  inspectManager?: () => Promise<ServiceSnapshot>;
  inspectLinuxService?: (
    selectPaths: (env: NodeJS.ProcessEnv) => LinuxPaths,
  ) => Promise<LinuxServiceStatus>;
  controlStatus?: (socket: string) => Promise<unknown>;
  tmuxVersion?: (env: NodeJS.ProcessEnv) => Promise<string>;
  checkHerdr?: (env: NodeJS.ProcessEnv) => Promise<HerdrCheck>;
  relayHealth?: (relayUrl: string) => Promise<boolean>;
  itermSocketExists?: () => boolean;
}

/** Pure: `tmux -V` output -> a comparable number, or null when it is not recognisable. */
export function parseTmuxVersion(stdout: string): number | null {
  const m = /(\d+)\.(\d+)/.exec(stdout);
  if (!m) return null;
  return Number(m[1]) + Number(m[2]) / 100;
}

export function doctorExitCode(checks: readonly Check[]): 0 | 1 {
  return checks.some((check) => check.severity === "error") ? 1 : 0;
}

function pass(name: string, detail: string): Check {
  return { name, ok: true, severity: "pass", detail };
}
function warning(name: string, detail: string, fix?: string): Check {
  return { name, ok: true, severity: "warning", detail, ...(fix ? { fix } : {}) };
}
function error(name: string, detail: string, fix?: string): Check {
  return { name, ok: false, severity: "error", detail, ...(fix ? { fix } : {}) };
}
function backendRow(name: Backend, connected: boolean, required: boolean, setup: Check): Check {
  if (connected)
    return { ...pass(name, "connected to the local agent"), ...(required ? { required } : {}) };
  if (!required) return setup;
  return {
    ...error(name, `required backend is not connected; ${setup.detail}`, setup.fix),
    required: true,
  };
}

function onPath(binary: string, env: NodeJS.ProcessEnv): boolean {
  for (const dir of env.PATH?.split(delimiter) ?? []) {
    if (!dir) continue;
    try {
      accessSync(join(dir, binary), constants.X_OK);
      return true;
    } catch {
      /* absent from this PATH entry */
    }
  }
  return false;
}

async function defaultTmuxVersion(env: NodeJS.ProcessEnv): Promise<string> {
  return (await run("tmux", ["-V"], { env, timeout: 3_000, maxBuffer: 64 * 1024 })).stdout;
}

async function defaultHerdrCheck(env: NodeJS.ProcessEnv): Promise<HerdrCheck> {
  return checkHerdr({
    socketPath: herdrSocketPath(env),
    herdrOnPath: () => onPath("herdr", env),
  });
}

function setupEnvironment(
  snapshot: ServiceSnapshot,
  shell: NodeJS.ProcessEnv,
): { env: NodeJS.ProcessEnv; context: string } {
  if (!snapshot.installed || !snapshot.definition)
    return { env: shell, context: "current shell setup" };
  const saved = snapshot.definition.environment;
  return {
    env: {
      PATH: saved.PATH,
      HERDR_SOCKET_PATH: saved.HERDR_SOCKET_PATH,
      XDG_CONFIG_HOME: saved.XDG_CONFIG_HOME,
    },
    context: "installed service setup",
  };
}

function managerCheck(snapshot: ServiceSnapshot, local: LocalStatus | null): Check {
  if (snapshot.loaded && !snapshot.installed)
    return error("service manager", "loaded service has no installed definition");
  if (!snapshot.installed)
    return warning(
      "service manager",
      "no service definition installed; foreground agent can still run",
      "run `shellbell service install` for autostart",
    );
  if (!snapshot.definition)
    return error(
      "service manager",
      "installed service definition is unreadable",
      "reinstall the service after checking its definition",
    );
  if (!snapshot.loaded)
    return warning(
      "service manager",
      "installed service is stopped",
      "run `shellbell service start` if background operation is wanted",
    );
  if (!snapshot.definition.serviceInstance)
    return warning(
      "service manager",
      "legacy service definition has no verifiable instance marker",
      "reinstall the service to record a service instance",
    );
  if (!local)
    return warning("service manager", "loaded job cannot be matched until local control responds");
  if (local.process.serviceInstance !== snapshot.definition.serviceInstance)
    return error(
      "service manager",
      "loaded job does not match the local service instance",
      "stop the foreground owner and restart the service",
    );
  return pass("service manager", "loaded job matches the local service instance");
}

function linuxManagerCheck(status: LinuxServiceStatus): Check {
  const detail = `installed=${status.installed}; enabled=${status.enabled}; active=${status.activeState}; authenticated ready=${status.ready}; linger=${status.linger}; ownership=${status.ownership}${status.diagnostic ? `; ${status.diagnostic}` : ""}`;
  if (status.activeState === "unknown")
    return warning(
      "service manager",
      detail,
      "restore access to the current user's systemd manager; foreground readiness is independent",
    );
  if (status.ownership === "foreign")
    return error(
      "service manager",
      detail,
      "inspect the exact unit and any drop-ins; Shellbell refuses foreign definitions",
    );
  if (status.ready) return pass("service manager", detail);
  return warning(
    "service manager",
    detail,
    "inspect shellbell service status; install, start, and enable are separate choices; foreground readiness is independent",
  );
}

function unknownChecks(reason: string, required: readonly Backend[]): Check[] {
  const unavailable = (name: Backend): Check =>
    required.includes(name)
      ? {
          ...error(name, "required backend unavailable until service state is selected"),
          required: true,
        }
      : warning(name, "unavailable until service state is selected");
  return [
    warning("identity", reason),
    error("service manager", reason),
    warning("control", "unavailable until service state is selected"),
    warning("relay", "unavailable until service state is selected"),
    unavailable("iterm2"),
    unavailable("tmux"),
    unavailable("herdr"),
    warning("terminal readiness", "unavailable until service state is selected"),
  ];
}

export async function runDoctor(
  options: DoctorOptions,
  deps: RunDoctorDeps = {},
): Promise<Check[]> {
  const linux = (options.platform ?? process.platform) === "linux";
  let linuxServiceCheck = warning(
    "service manager",
    "Linux systemd user-manager inspection unavailable; foreground readiness is independent",
    "inspect shellbell service status and the current user's systemd manager",
  );
  const unsupported = (name: "iterm2" | "herdr"): Check => ({
    ...error(
      name,
      name === "herdr"
        ? "Shellbell's Herdr backend is not yet qualified for Linux delivery (Herdr itself supports Linux)"
        : "iTerm2 is not supported on Linux",
    ),
    required: true,
  });
  const unsupportedChecks = options.requiredBackends
    .filter((name): name is "iterm2" | "herdr" => name !== "tmux")
    .map(unsupported);
  let snapshot: ServiceSnapshot | null = null;
  let p!: Paths;
  if (linux) {
    let selected: LinuxPaths | undefined;
    let selectedEnv: NodeJS.ProcessEnv = {
      ...options.env,
      SHELLBELL_DIR: options.requestedStateDir ?? options.env.SHELLBELL_DIR,
    };
    const selectPaths = (env: NodeJS.ProcessEnv): LinuxPaths => {
      selectedEnv = env;
      selected = (deps.selectLinuxPaths ?? ((env) => resolveLinuxPaths({ env })))(env);
      return selected;
    };
    try {
      linuxServiceCheck = linuxManagerCheck(
        await (
          deps.inspectLinuxService ??
          (() =>
            new SystemdServiceLifecycle({
              env: selectedEnv,
              selectPaths,
            }).status())
        )(selectPaths),
      );
    } catch {
      // Keep manager availability independent from foreground state and backend checks.
    }
    let stateCheck: Check;
    try {
      // The installed definition may select a custom directory absent from the shell.
      // Retain exactly the paths admitted during lifecycle inspection for every check.
      const admitted = selected ?? selectPaths(selectedEnv);
      p = admitted;
      const state = inspectLinuxState(admitted);
      stateCheck =
        state.status === "ready"
          ? pass("host state", "Linux host state admitted")
          : error(
              "host state",
              state.reason ?? "Linux host state is absent",
              "initialize absent state with shellbell host init --new, or inspect existing state before recovery",
            );
    } catch {
      stateCheck = error(
        "host state",
        "Linux state or runtime selection is unsafe or unavailable",
        "use a nonroot matching real/effective user, a valid machine ID, and a private 0700 local runtime directory",
      );
    }
    if (stateCheck.severity === "error")
      return [
        stateCheck,
        linuxServiceCheck,
        warning("control", "unavailable until host state is admitted"),
        warning("relay", "unavailable until host state is admitted"),
        ...unsupportedChecks,
        options.requiredBackends.includes("tmux")
          ? {
              ...error("tmux", "required backend unavailable until host state is admitted"),
              required: true,
            }
          : warning("tmux", "unavailable until host state is admitted"),
      ];
  } else {
    try {
      snapshot = await (deps.inspectManager ?? (() => createLaunchdManager().inspect()))();
    } catch {
      return unknownChecks(
        "service manager inspection failed; state unavailable",
        options.requiredBackends,
      );
    }
    try {
      p = selectServicePaths(snapshot, options.requestedStateDir, options.defaultStateDir);
    } catch {
      return unknownChecks(
        "state selection unavailable; check SHELLBELL_DIR against installed service",
        options.requiredBackends,
      );
    }
  }

  let identityCheck: Check;
  let fp: string | null = null;
  try {
    const found = readIdentity(p);
    if (found) {
      fp = found.fp;
      identityCheck = pass(
        "identity",
        linux ? "valid admitted Linux identity" : `valid identity at ${p.identity}`,
      );
    } else
      identityCheck = error(
        "identity",
        `identity missing at ${p.identity}`,
        "start Shellbell once to create an identity",
      );
  } catch {
    identityCheck = error(
      "identity",
      linux
        ? "Linux identity invalid or unreadable"
        : `identity invalid or unreadable at ${p.identity}`,
      "restore the original identity file; do not replace paired keys",
    );
  }

  let local: LocalStatus | null = null;
  let controlCheck: Check;
  if (!fp) controlCheck = error("control", "cannot verify local process without a valid identity");
  else {
    try {
      const payload = await (
        deps.controlStatus ??
        ((socket) =>
          controlRequest(socket, "status", undefined, {
            timeoutMs: 500,
            maxResponseBytes: 64 * 1024,
          }))
      )(p.sock);
      const parsed = LocalStatusSchema.safeParse(payload);
      if (!parsed.success)
        controlCheck = error("control", "local endpoint returned malformed or unsupported status");
      else if (!matchesLocalService(parsed.data, { computerFp: fp, stateDir: p.dir }))
        controlCheck = error(
          "control",
          "local endpoint belongs to a different identity or state directory",
        );
      else {
        local = parsed.data;
        controlCheck = pass("control", "local agent identity and state verified");
      }
    } catch {
      controlCheck = error(
        "control",
        "local endpoint is absent or did not return bounded status",
        "start Shellbell, or inspect the configured service",
      );
    }
  }

  const serviceCheck = linux ? linuxServiceCheck : managerCheck(snapshot!, local);
  let relayCheck: Check | null = null;
  let relayUrl: string | null = null;
  try {
    relayUrl = readConfig(p).relayUrl;
  } catch {
    relayCheck = error(
      "relay",
      linux
        ? "Linux configuration invalid or unreadable"
        : `configuration invalid or unreadable at ${p.config}`,
      "repair the existing config without replacing identity files",
    );
  }
  if (!relayCheck) {
    if (local?.relayOnline) relayCheck = pass("relay", "local agent reports relay connected");
    else {
      let endpoint = "configured relay";
      let reachable = false;
      try {
        const url = new URL(relayUrl!);
        if (["ws:", "wss:", "http:", "https:"].includes(url.protocol)) {
          endpoint = `${url.protocol === "ws:" ? "http:" : url.protocol === "wss:" ? "https:" : url.protocol}//${url.host}/healthz`;
          reachable = await (deps.relayHealth ?? probeRelayHealth)(relayUrl!);
        }
      } catch {
        /* invalid URL or bounded probe failed */
      }
      relayCheck = error(
        "relay",
        `local agent is not relay-connected; ${endpoint} ${reachable ? "is reachable" : "is not confirmed reachable"} (HTTP health does not prove WebSocket authorization)`,
        "check the relay URL, network, and running agent",
      );
    }
  }

  const { env, context } = linux
    ? { env: options.env, context: "current shell setup" }
    : setupEnvironment(snapshot!, options.env);
  const required = new Set(options.requiredBackends);
  const connected = (name: Backend) =>
    local?.backends.find((backend) => backend.name === name)?.connected === true;
  let itermSetup: Check = warning(
    "iterm2",
    `${context}: iTerm2 API socket unavailable`,
    "enable iTerm2 Python API, then start Shellbell to authorize access",
  );
  if (!linux && !connected("iterm2")) {
    try {
      if ((deps.itermSocketExists ?? (() => existsSync(DEFAULT_SOCKET)))())
        itermSetup = warning(
          "iterm2",
          `${context}: API socket exists but agent is disconnected`,
          "start Shellbell to authorize iTerm2 API access",
        );
    } catch {
      itermSetup = error("iterm2", "iTerm2 API socket inspection failed");
    }
  }
  const itermCheck = backendRow("iterm2", connected("iterm2"), required.has("iterm2"), itermSetup);

  let tmuxSetup: Check = warning(
    "tmux",
    `${context}: tmux is unavailable`,
    "install tmux 3.2 or newer",
  );
  if (!connected("tmux")) {
    try {
      const version = parseTmuxVersion(await (deps.tmuxVersion ?? defaultTmuxVersion)(env));
      tmuxSetup =
        version === null || version < 3.02
          ? error(
              "tmux",
              `${context}: tmux version is unsupported or unrecognizable`,
              "install tmux 3.2 or newer",
            )
          : warning(
              "tmux",
              `${context}: tmux 3.2+ is installed but not connected`,
              "start a tmux session and Shellbell",
            );
    } catch (failure) {
      tmuxSetup =
        (failure as NodeJS.ErrnoException).code === "ENOENT"
          ? warning("tmux", `${context}: tmux executable not found`, "install tmux 3.2 or newer")
          : error(
              "tmux",
              `${context}: tmux version probe failed`,
              "check installed tmux and the saved PATH",
            );
    }
  }
  const tmuxCheck = backendRow("tmux", connected("tmux"), required.has("tmux"), tmuxSetup);

  let herdrSetup: Check = warning("herdr", `${context}: Herdr is unavailable`, INSTALL_HINT);
  if (!linux && !connected("herdr")) {
    try {
      const result = await (deps.checkHerdr ?? defaultHerdrCheck)(env);
      if (!result.ok)
        herdrSetup = error("herdr", `${context}: Herdr API is broken or unsupported`, UPGRADE_HINT);
      else if (result.detail === "not installed (optional)")
        herdrSetup = warning("herdr", `${context}: Herdr not found on PATH`, INSTALL_HINT);
      else if (result.detail === "installed but not running (optional)")
        herdrSetup = warning(
          "herdr",
          `${context}: Herdr is installed but not running`,
          "start Herdr and Shellbell",
        );
      else
        herdrSetup = warning(
          "herdr",
          `${context}: Herdr API available but agent is disconnected`,
          "start Shellbell with Herdr enabled",
        );
    } catch {
      herdrSetup = error("herdr", `${context}: Herdr API probe failed`, UPGRADE_HINT);
    }
  }
  const herdrCheck = backendRow("herdr", connected("herdr"), required.has("herdr"), herdrSetup);
  const terminalCheck = (linux ? connected("tmux") : local?.terminalReady)
    ? pass("terminal readiness", "at least one backend connected to the verified local agent")
    : error(
        "terminal readiness",
        "no backend connected to a verified local agent",
        "start Shellbell with a supported terminal backend",
      );

  return [
    ...(linux ? [pass("host state", "Linux host state admitted")] : []),
    identityCheck,
    serviceCheck,
    controlCheck,
    relayCheck,
    ...(linux ? unsupportedChecks : [itermCheck]),
    tmuxCheck,
    ...(linux ? [] : [herdrCheck]),
    terminalCheck,
  ];
}
