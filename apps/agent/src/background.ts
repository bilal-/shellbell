import { existsSync } from "node:fs";
import { homedir, hostname } from "node:os";
import { join } from "node:path";
import { defaultConfig } from "./config.js";
import { initializeLinuxHost } from "./host-init.js";
import { type LinuxPaths, resolveLinuxPaths } from "./host-paths.js";
import { inspectLinuxState, linuxStateProblem } from "./host-state.js";
import { createLaunchdManager } from "./launchd.js";
import { ServiceLifecycle, type ServiceStatus } from "./service-lifecycle.js";
import { resolveServiceRuntime } from "./service-runtime.js";
import { type LinuxServiceStatus, SystemdServiceLifecycle } from "./systemd-lifecycle.js";

/** Where the background Shellbell stands, in the words the commands print. */
export interface BackgroundStatus {
  installed: boolean;
  /** Running and answering as the expected Shellbell. */
  running: boolean;
  /** Comes back by itself after a restart (at login). */
  startsAtLogin: boolean;
  /** This computer can run Shellbell in the background at all. */
  available: boolean;
  /** Linux only: keeps running after its user logs out. */
  keepsRunningAfterLogout?: boolean;
  /** The running version, when it answers. */
  version: string | null;
  service: ServiceStatus | LinuxServiceStatus;
}

/** The background Shellbell of this computer, the same on macOS and Linux. */
export interface Background {
  readonly system: "macos" | "linux";
  /** Throws, before anything is read or written, when this Shellbell can't be installed, such as
   * a source checkout or a copy in a temporary folder. */
  checkRuntime(): void;
  status(): Promise<BackgroundStatus>;
  /** Installs, turns on start-at-login and starts it, unless this version already runs. */
  install(version: string): Promise<BackgroundStatus>;
  start(): Promise<BackgroundStatus>;
  /** Stops it now; it starts again at the next login. */
  stop(): Promise<BackgroundStatus>;
  restart(): Promise<BackgroundStatus>;
  uninstall(): Promise<BackgroundStatus>;
}

type Runtime = { nodePath: string; cliPath: string };
type Lifecycle<T> = {
  installedRuntime(): Promise<(Runtime & { stateDir: string }) | null>;
  status(): Promise<T>;
  install(): Promise<T>;
  start(): Promise<T>;
  stop(): Promise<T>;
  restart(): Promise<T>;
  uninstall(): Promise<T>;
  enable(): Promise<T>;
};

/** Whether the background copy already runs this exact Shellbell, so installing changes nothing. */
async function current(
  lifecycle: Pick<Lifecycle<unknown>, "installedRuntime">,
  s: BackgroundStatus,
  version: string,
  runtime: () => Runtime,
): Promise<boolean> {
  if (!s.running || s.version !== version) return false;
  const installed = await lifecycle.installedRuntime();
  const wanted = runtime();
  return installed?.nodePath === wanted.nodePath && installed.cliPath === wanted.cliPath;
}

export function macBackground(
  lifecycle: Lifecycle<ServiceStatus>,
  runtime: () => Runtime = resolveServiceRuntime,
): Background {
  const view = (s: ServiceStatus): BackgroundStatus => ({
    installed: s.installed,
    running: s.ready,
    startsAtLogin: s.installed && s.startupEnabled !== false,
    available: true,
    version: s.ready ? (s.local?.process.agentVersion ?? null) : null,
    service: s,
  });
  return {
    system: "macos",
    checkRuntime: () => void runtime(),
    status: async () => view(await lifecycle.status()),
    async install(version) {
      let s = view(await lifecycle.status());
      if (!(await current(lifecycle, s, version, runtime))) s = view(await lifecycle.install());
      if (!s.startsAtLogin) s = view(await lifecycle.enable());
      return s;
    },
    async start() {
      const s = view(await lifecycle.status());
      return s.running ? s : view(await lifecycle.start());
    },
    stop: async () => view(await lifecycle.stop()),
    restart: async () => view(await lifecycle.restart()),
    uninstall: async () => view(await lifecycle.uninstall()),
  };
}

export function linuxBackground(
  lifecycle: Lifecycle<LinuxServiceStatus>,
  ensureHost: (installedStateDir: string | null) => Promise<void>,
  runtime: () => Runtime = resolveServiceRuntime,
): Background {
  const view = (s: LinuxServiceStatus): BackgroundStatus => ({
    installed: s.installed,
    running: s.ready,
    // Any enablement starts it at login, also one Shellbell didn't create.
    startsAtLogin: s.enabled,
    available: s.installed || s.activeState !== "unknown",
    keepsRunningAfterLogout: s.linger === "yes",
    version: s.ready ? (s.local?.process.agentVersion ?? null) : null,
    service: s,
  });
  return {
    system: "linux",
    checkRuntime: () => void runtime(),
    status: async () => view(await lifecycle.status()),
    async install(version) {
      let s = view(await lifecycle.status());
      // Ask systemd first, so a computer that can't run services keeps its state folder as it was.
      if (!s.available) return s;
      await ensureHost((await lifecycle.installedRuntime())?.stateDir ?? null);
      if (!(await current(lifecycle, s, version, runtime))) {
        // systemd keeps an active unit's definition; replace it only while stopped.
        if (s.installed) await lifecycle.stop();
        await lifecycle.install();
        if (!(await lifecycle.status()).enabled) await lifecycle.enable();
        s = view(await lifecycle.start());
      }
      return s.startsAtLogin ? s : view(await lifecycle.enable());
    },
    async start() {
      const s = view(await lifecycle.status());
      return s.running ? s : view(await lifecycle.start());
    },
    stop: async () => view(await lifecycle.stop()),
    restart: async () => view(await lifecycle.restart()),
    uninstall: async () => view(await lifecycle.uninstall()),
  };
}

/**
 * Creates this Linux computer's identity when it has no Shellbell state yet. State that exists
 * but that this computer did not create, such as a copy from another computer, is never taken
 * over: two computers sharing one identity would answer for each other. Nor is a new identity
 * made while an installed service or an older Shellbell keeps its identity somewhere else:
 * phones paired with that one would lose this computer.
 */
export async function ensureLinuxHost(
  p: LinuxPaths = resolveLinuxPaths(),
  options: { installedStateDir?: string | null; home?: string } = {},
): Promise<void> {
  const state = inspectLinuxState(p);
  if (state.status === "ready" && (options.installedStateDir ?? p.dir) === p.dir) return;
  if (state.status !== "absent" && state.status !== "ready")
    throw new Error(linuxStateProblem(p.dir, state.status));
  const legacy = join(options.home ?? homedir(), ".shellbell");
  const elsewhere =
    options.installedStateDir ?? (existsSync(join(legacy, "identity.json")) ? legacy : null);
  if (elsewhere)
    throw new Error(
      elsewhere === p.dir
        ? `Shellbell's background service keeps its identity in ${p.dir}, but the identity is missing. To keep your paired phones, Shellbell won't make a new one. Restore the folder from a backup, or run \`shellbell uninstall\` to start over and pair your phones again.`
        : `Shellbell already has an identity on this computer, in ${elsewhere}, but is looking in ${p.dir}. To keep your paired phones, Shellbell won't make a new one. Run Shellbell with the same SHELLBELL_DIR as before, or see the Linux guide to move it.`,
    );
  await initializeLinuxHost(
    p,
    { kind: "new" },
    { ...defaultConfig(), computerName: hostname().replace(/\.local$/, "") || "Linux" },
  );
}

export function createBackground(platform: NodeJS.Platform = process.platform): Background {
  if (platform === "linux")
    return linuxBackground(new SystemdServiceLifecycle({ env: process.env }), (installedStateDir) =>
      ensureLinuxHost(undefined, { installedStateDir }),
    );
  if (platform !== "darwin")
    throw new Error("Shellbell runs in the background on macOS and Linux only.");
  return macBackground(
    new ServiceLifecycle({
      manager: createLaunchdManager(),
      requestedStateDir: process.env.SHELLBELL_DIR || undefined,
      defaultStateDir: join(homedir(), ".shellbell"),
      env: process.env,
    }),
  );
}
