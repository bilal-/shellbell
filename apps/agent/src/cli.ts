#!/usr/bin/env node
import { spawn } from "node:child_process";
import { closeSync, existsSync, fstatSync, openSync, readSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { Command } from "commander";
import qrcode from "qrcode-terminal";
import pkg from "../package.json" with { type: "json" };
import { Agent } from "./agent.js";
import { HerdrBackend } from "./backends/herdr/backend.js";
import { findHerdrExecutable } from "./backends/herdr/executable.js";
import { startHerdrBackend } from "./backends/herdr/start.js";
import { ITerm2Backend } from "./backends/iterm2/backend.js";
import { ITerm2Client } from "./backends/iterm2/client.js";
import { startTerminalPlugins } from "./backends/plugin.js";
import { BACKEND_ORDER, BackendRegistry } from "./backends/registry.js";
import {
  herdrServerLauncher,
  macApplicationLauncher,
  waitForBackend,
} from "./backends/session-startup.js";
import {
  ghosttyWindowLauncher,
  type TerminalWindowLauncher,
  terminalCommandLine,
} from "./backends/terminal-launch.js";
import { type StartTmuxOptions, startTmuxBackend } from "./backends/tmux/start.js";
import { BackendUnavailable } from "./backends/types.js";
import { type AgentConfig, defaultConfig, editConfig, loadConfig, type Paths } from "./config.js";
import { CONFIG_KEYS, resolveConfigSet, validateRelayUrl } from "./config-values.js";

export {
  CONFIG_KEYS,
  type ConfigKey,
  resolveConfigSet,
  validateRelayUrl,
} from "./config-values.js";

import { ControlServer, controlPairSession, controlRequest } from "./control.js";
import { type Check, doctorExitCode, runDoctor } from "./doctor.js";
import { addHostCommand, selectAgentPaths } from "./host-command.js";
import { type LinuxPaths, prepareLinuxRuntime } from "./host-paths.js";
import { requireLinuxState } from "./host-state.js";
import { loadOrCreateIdentity } from "./identity.js";
import { createLaunchdManager } from "./launchd.js";
import { serviceInstanceFromEnvironment } from "./local-status.js";
import { createLogger, type Logger, safeErrorName } from "./log.js";
import { ServiceLifecycle, ServiceLifecycleError } from "./service-lifecycle.js";
import { requireHeadlessEngine, withHeadlessEngineAdmission } from "./service-ownership.js";
import { SystemdServiceLifecycle } from "./systemd-lifecycle.js";

const VERSION = pkg.version;
export const program = new Command()
  .name("shellbell")
  .version(VERSION)
  .option("--relay <url>", "override relay url")
  .option("--json", "machine output")
  .option("--verbose", "debug logging")
  .option("--insecure", "allow a ws:// relay url (LAN dev only)");

function ctx() {
  const opts = program.opts<{
    relay?: string;
    json?: boolean;
    verbose?: boolean;
    insecure?: boolean;
  }>();
  const p = selectAgentPaths();
  const cfg = loadConfig(p);
  const log = createLogger({
    file: p.log,
    verbose: opts.verbose,
    stdout: process.stdout.isTTY && !opts.json,
  });
  return { opts, p, cfg, log };
}

const fpShort = (fp: string) => `${fp.slice(0, 4)}-${fp.slice(4, 8)}`;

function askYesNo(question: string, timeoutMs: number): Promise<boolean> {
  return new Promise((resolve) => {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    const t = setTimeout(() => {
      rl.close();
      console.log("\n  (timed out — declined)");
      resolve(false);
    }, timeoutMs);
    rl.question(question, (a) => {
      clearTimeout(t);
      rl.close();
      resolve(/^y(es)?$/i.test(a.trim()));
    });
  });
}

function printPairHeader(cfg: AgentConfig, fp: string): void {
  console.log(
    `\n  Computer   ${cfg.computerName}  (${fpShort(fp)})\n  Relay      ${cfg.relayUrl}\n\n  Scan this with the Shellbell app:\n`,
  );
}

function printQr(qrText: string, expiresAt: number): void {
  qrcode.generate(qrText, { small: true }, (qr) => {
    console.log(
      qr
        .split("\n")
        .map((l) => `  ${l}`)
        .join("\n"),
    );
    console.log(
      `\n  Pairing window closes in ${Math.round((expiresAt - Date.now()) / 60000)} min\n`,
    );
  });
}

/** Reads only the tail of a file (bounded I/O for a long-lived, rotated agent.log) and returns
 * its last `maxLines` lines. */
export function tailFile(path: string, maxBytes: number, maxLines: number): string {
  const fd = openSync(path, "r");
  try {
    const size = fstatSync(fd).size;
    const start = Math.max(0, size - maxBytes);
    const len = size - start;
    const buf = Buffer.alloc(len);
    if (len > 0) readSync(fd, buf, 0, len, start);
    // Drop exactly one trailing newline (every log record ends with one) so the split below
    // yields real lines only -- without this, `slice(-maxLines)` counts the trailing "" as a
    // line and silently drops the actual last line of the file.
    const text = buf.toString("utf8").replace(/\n$/, "");
    return text.length === 0 ? "" : text.split("\n").slice(-maxLines).join("\n");
  } finally {
    closeSync(fd);
  }
}

/** Read-only reachability check. Endpoint startup owns serialized stale cleanup. */
export async function socketAlive(sockPath: string): Promise<boolean> {
  try {
    await controlRequest(sockPath, "status");
    return true;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ECONNREFUSED" || code === "ENOENT") {
      return false;
    }
    // Any other failure (timeout, a malformed reply) still proves *something* is listening;
    // do not treat it as a stale socket and do not touch the file.
    return true;
  }
}

/**
 * Routes a pairing confirmation to whichever surface can actually show it: a connected
 * `pair-open` control-socket client (there is a human watching that terminal for exactly this),
 * falling back to this process's own TTY only when no such client is connected. Never reads the
 * daemon's stdin when a pair client is present, even if the daemon itself has a TTY (critical
 * fix: a foreground `start` with a TTY must not swallow a `pair`-triggered request).
 */
export function chooseConfirm(
  box: { server: ControlServer | null },
  yes: boolean,
  askYesNoFn: (phoneFp: string, name: string) => Promise<boolean>,
  interactive = true,
): (phoneFp: string, name: string) => Promise<boolean> {
  return async (phoneFp, name) => {
    if (box.server?.hasNativePairOwner) return box.server.nativePairingConfirm(phoneFp, name);
    if (!interactive) return false;
    if (yes) return true;
    if (box.server?.hasPairClients) return box.server.pairingConfirm(phoneFp, name);
    return askYesNoFn(phoneFp, name);
  };
}

/** One shutdown path for `start`: stops the agent and the control server (which removes
 * `agent.sock` and `agent.pid`), then exits. Shared by SIGINT/SIGTERM and `onSuperseded` so
 * neither leaves stale files behind.
 *
 * A hard 5 s deadline guarantees `exit` is always called even if `control.stop()` hangs (e.g. a
 * socket that never emits `close`) -- Ctrl-C must never leave the process unkillable. `cleanup`,
 * when given, runs synchronously first (e.g. cancelling `buildAgent`'s first-connect retry timer).
 */
export async function shutdown(
  agent: Agent,
  control: ControlServer,
  exit: (code: number) => void = process.exit,
  cleanup?: () => void,
): Promise<void> {
  cleanup?.();
  let exited = false;
  const onceExit = (code: number) => {
    if (exited) return;
    exited = true;
    exit(code);
  };
  const hardDeadline = setTimeout(() => onceExit(1), 5000);
  if (typeof hardDeadline.unref === "function") hardDeadline.unref();
  try {
    agent.stop();
    await control.stop();
    onceExit(0);
  } finally {
    clearTimeout(hardDeadline);
  }
}

/**
 * Pure: resolves the explicit `--relay <url>` flag against the loaded config. Unlike
 * `config set relay`, `ws://` is always accepted here (no `--insecure` needed) since the flag
 * only steers a single foreground run and is documented as a local development option (for example,
 * `--relay ws://localhost:8787`) -- but it still fails closed on a genuinely bad
 * URL (I2). Returns the config unchanged, with a `warning` to print, when no override is given.
 */
export function resolveRelayOverride(
  cfg: AgentConfig,
  relayOverride: string | undefined,
): { error: string } | { cfg: AgentConfig; warning?: string } {
  if (relayOverride === undefined) return { cfg };
  const err = validateRelayUrl(relayOverride, true);
  if (err) return { error: err };
  const insecure = new URL(relayOverride).protocol === "ws:";
  return {
    cfg: { ...cfg, relayUrl: relayOverride },
    warning: insecure ? "insecure relay URL; for local testing only" : undefined,
  };
}

/** Test seam (M-6): lets `cli.test.ts` drive the tmux banner lines with a fake `execImpl`/
 * `controlFactory` -- same shape `tmux-start.test.ts` already injects -- without a real tmux
 * server. Defaults to nothing, so production behaviour (the real binary) is unchanged. */
export interface BuildAgentDeps {
  paths?: Paths;
  tmuxBackendOptions?: StartTmuxOptions["backendOptions"];
  serviceInstance?: string | null;
  managedService?: boolean;
  nativeService?: boolean;
  itermBackend?: ITerm2Backend | null;
  startHerdr?: typeof startHerdrBackend;
  terminalWindows?: readonly TerminalWindowLauncher[];
}

export async function buildAgent(
  log: Logger,
  relayOverride?: string,
  yes = false,
  deps: BuildAgentDeps = {},
) {
  const p = deps.paths ?? selectAgentPaths();
  const admitOwnership = deps.nativeService
    ? undefined
    : () =>
        requireHeadlessEngine({
          stateDir: p.dir,
          uid: p.linuxHost?.uid ?? process.getuid!(),
          serviceInstance: deps.serviceInstance,
        });
  admitOwnership?.();
  if (p.linuxHost) {
    requireLinuxState(p as LinuxPaths);
    prepareLinuxRuntime(p as LinuxPaths);
  }
  let cfg = loadConfig(p);
  if (relayOverride !== undefined) {
    // I2: --relay must steer BOTH the agent's own socket and the pairing QR (the QR's `r`), or a
    // scanned QR dials a relay the agent never connected to. Routing it into `cfg.relayUrl` here
    // (rather than the test-only `relayUrlOverride` seam) makes PairingManager and RelayClient
    // agree, exactly like `config set relay` already does for a persisted override.
    const resolved = resolveRelayOverride(cfg, relayOverride);
    if ("error" in resolved) {
      console.error(`  --relay ${relayOverride}: ${resolved.error}`);
      process.exit(1);
    }
    if (resolved.warning) console.error(`  warning: ${resolved.warning}`);
    cfg = resolved.cfg;
  }
  const { identity, fp } = loadOrCreateIdentity(p);
  const registry = new BackendRegistry(log);
  const terminalPlugins = startTerminalPlugins({ paths: cfg.terminalPlugins ?? [], registry, log });
  const iterm = p.linuxHost
    ? null
    : deps.itermBackend === undefined
      ? new ITerm2Backend(new ITerm2Client({ log }), log)
      : deps.itermBackend;
  // Minor: `firstConnect` below can otherwise print its backend line before the caller's own
  // header block (both `start` and `pair` print a header only after `buildAgent()`
  // returns) if iTerm2 answers fast -- buffer stdout lines here and let the caller release them
  // once its header is up, so the two can never interleave.
  const output: { ready: boolean; queue: string[] } = { ready: false, queue: [] };
  const print = (line: string) => {
    if (deps.nativeService) return;
    if (output.ready) console.log(line);
    else output.queue.push(line);
  };
  const releaseOutput = () => {
    output.ready = true;
    for (const line of output.queue) console.log(line);
    output.queue = [];
  };
  // ITerm2Backend owns reconnect once it has connected at least once (1 s -> 30 s).
  // The CLI only retries the FIRST connect, which is what fails while iTerm2 is closed or its
  // Python API is off. Re-detect every 10 s while the backend is absent.
  let firstConnectTimer: NodeJS.Timeout | null = null;
  let firstConnectFlight: Promise<void> | null = null;
  let firstConnectStopped = false;
  const attemptFirstConnect = async () => {
    if (!iterm || firstConnectStopped) return;
    try {
      await iterm.connect();
      if (firstConnectStopped) return;
      registry.add(iterm);
      const sessions = await iterm.listSessions().catch(() => []);
      if (firstConnectStopped) return;
      print(
        `  iTerm2     connected · ${sessions.length} session${sessions.length === 1 ? "" : "s"}`,
      );
      log.info("iTerm2 connected");
    } catch (err) {
      if (firstConnectStopped) return;
      if (err instanceof BackendUnavailable) {
        // Show setup instructions for a disabled Python API.
        print(
          "\n  iTerm2's Python API is off. Turn it on:\n  iTerm2 → Settings → General → Magic → ✓ Enable Python API\n  then run `shellbell` again.\n",
        );
        log.warn("iTerm2 unavailable", { error: safeErrorName(err) });
      } else {
        print("  iTerm2     unavailable — connect failed");
        log.warn("iTerm2 connect failed", { err: safeErrorName(err) });
      }
      firstConnectTimer = setTimeout(() => void firstConnect(), 10_000);
    }
  };
  const firstConnect = (): Promise<void> => {
    if (firstConnectStopped) return Promise.resolve();
    if (firstConnectFlight) return firstConnectFlight;
    if (firstConnectTimer) clearTimeout(firstConnectTimer);
    firstConnectTimer = null;
    firstConnectFlight = attemptFirstConnect().finally(() => {
      firstConnectFlight = null;
    });
    return firstConnectFlight;
  };
  if (iterm?.isConnected === false) registry.add(iterm);
  if (iterm) void firstConnect();
  // herdr is optional and usually absent, so this never blocks startup and never
  // prints an error -- it registers the backend, retries every 10 s, and announces itself if and
  // when it connects. Buffered through `print` like the iTerm2 line, for the same reason.
  // tmux is optional and often absent, so this never blocks startup. It registers
  // the backend, retries every 10 s while the server is down, and announces itself if and when it
  // connects. Buffered through `print` like the iTerm2 and herdr lines, for the same reason.
  const itermLauncher =
    !p.linuxHost && deps.itermBackend === undefined ? macApplicationLauncher("iterm2") : null;
  const ghosttyLauncher =
    !p.linuxHost && deps.tmuxBackendOptions === undefined ? ghosttyWindowLauncher() : null;
  const terminalWindows: readonly TerminalWindowLauncher[] = deps.terminalWindows ?? [
    ...(ghosttyLauncher ? [ghosttyLauncher] : []),
    ...(iterm && itermLauncher
      ? [
          {
            id: "iterm2",
            label: "iTerm2",
            available: itermLauncher.available,
            async launch(command: Parameters<TerminalWindowLauncher["launch"]>[0]) {
              if (!registry.connected().some((backend) => backend.name === "iterm2")) {
                await itermLauncher.start();
                await firstConnect();
                await waitForBackend(registry, "iterm2");
              }
              if (registry.member("iterm2") !== iterm)
                throw new BackendUnavailable("iTerm2 was replaced", "Reconnect your computer.");
              await iterm.createCommandSession(terminalCommandLine(command));
            },
          },
        ]
      : []),
  ];
  const tmux = startTmuxBackend({
    registry,
    log,
    onConnected: (n) => print(`  tmux       connected · ${n} pane${n === 1 ? "" : "s"}`),
    onUnavailable: () => print("  tmux       not running"),
    backendOptions: deps.tmuxBackendOptions,
    terminalWindows,
  });
  const herdr = p.linuxHost
    ? null
    : (deps.startHerdr ?? startHerdrBackend)({
        registry,
        log,
        onConnected: (n) => print(`  herdr      connected · ${n} pane${n === 1 ? "" : "s"}`),
        // Resolves the `detecting…` banner line below when Herdr just isn't running -- the (silent)
        // 10 s retry loop keeps going regardless, so a later `onConnected` still fires normally.
        onUnavailable: () => print("  herdr      not running (optional)"),
      });
  // Minor: without this, the retry timer above outlives `stop()`/`shutdown()` -- harmless for the
  // CLI (every shutdown path calls `process.exit`) but it means `buildAgent` can't be reused in a
  // long-lived host. `shutdown()` calls this as its `cleanup` step.
  const stopFirstConnect = () => {
    terminalPlugins.stop();
    firstConnectStopped = true;
    if (firstConnectTimer) clearTimeout(firstConnectTimer);
    firstConnectTimer = null;
  };
  // `shutdown()`'s `cleanup` argument: cancel the iTerm2 first-connect retry AND stop the herdr
  // detector. Passed wherever `stopFirstConnect` used to be passed, so no exit path leaks either.
  const removeSessionLaunchers: (() => void)[] = [];
  if (iterm && itermLauncher) {
    removeSessionLaunchers.push(
      registry.registerSessionLauncher("iterm2", {
        available: itermLauncher.available,
        start: async () => {
          await itermLauncher.start();
          await firstConnect();
          await waitForBackend(registry, "iterm2");
          return { backend: iterm };
        },
      }),
    );
  }
  const herdrLauncher =
    !p.linuxHost && deps.startHerdr === undefined ? herdrServerLauncher() : null;
  if (herdrLauncher) {
    removeSessionLaunchers.push(
      registry.registerSessionLauncher("herdr", {
        available: herdrLauncher.available,
        start: async () => {
          await herdrLauncher.start();
          await waitForBackend(registry, "herdr");
          const backend = registry.member("herdr");
          if (!backend)
            throw new BackendUnavailable("Herdr unavailable", "Check Herdr's local API.");
          return { backend };
        },
      }),
    );
    for (const host of terminalWindows) {
      removeSessionLaunchers.push(
        registry.registerHostedLauncher(
          { backend: "herdr", host: host.id, label: host.label },
          {
            available: () => {
              const member = registry.member("herdr");
              return (
                host.available() &&
                (member instanceof HerdrBackend && member.isConnected
                  ? member.terminalAttachExecutable !== undefined
                  : findHerdrExecutable() !== undefined)
              );
            },
            create: async (backend) => {
              const executable =
                backend instanceof HerdrBackend ? backend.terminalAttachExecutable : undefined;
              if (!executable || !(backend instanceof HerdrBackend))
                throw new BackendUnavailable(
                  "Herdr terminal attach is unavailable",
                  "Use matching Herdr CLI/server versions, 0.9.3 or newer.",
                );
              const id = await backend.createWorkspaceSession();
              if (
                registry.member("herdr") !== backend ||
                backend.terminalAttachExecutable !== executable
              )
                throw new BackendUnavailable(
                  "Herdr was disconnected before the terminal could open",
                  "Reconnect Herdr and try again.",
                );
              await host.launch({
                executable,
                args: ["terminal", "attach", id],
                environment: { HERDR_SOCKET_PATH: backend.terminalSocketPath },
              });
              return id;
            },
          },
        ),
      );
    }
  }
  const stopBackendDetectors = () => {
    for (const remove of removeSessionLaunchers) remove();
    stopFirstConnect();
    tmux.stop();
    herdr?.stop();
  };
  const control: { server: ControlServer | null } = { server: null };
  let agent: Agent;
  agent = new Agent({
    paths: p,
    config: cfg,
    identity,
    fp,
    registry,
    log,
    appVersion: VERSION,
    serviceInstance: deps.serviceInstance ?? null,
    // relayUrlOverride intentionally omitted: cfg.relayUrl above (possibly overridden by --relay)
    // already steers both the socket and the pairing QR via PairingManager. relayUrlOverride
    // remains a genuinely test-only seam (agent.integration.test.ts) for pointing the socket at a
    // FakeRelay without disturbing a wss:// config the QR round-trip validation expects.
    confirm: chooseConfirm(
      control,
      yes,
      (phoneFp, name) =>
        askYesNo(`\n  Pair "${name}" (fp ${fpShort(phoneFp)})?  [y/N]  (60 s) `, 60_000),
      !deps.nativeService,
    ),
    onPairingClosed: () => control.server?.notifyClosed(),
    onSuperseded: () => {
      if (!deps.nativeService) console.log("  another shellbell agent took over; exiting");
      if (control.server) {
        void shutdown(agent, control.server, () => process.exit(0), stopBackendDetectors).catch(
          () => process.exit(1),
        );
      } else process.exit(0);
    },
  });
  control.server = new ControlServer(
    p.sock,
    agent,
    log,
    p.pid,
    admitOwnership,
    !deps.nativeService && !deps.managedService
      ? (start) =>
          withHeadlessEngineAdmission(
            { stateDir: p.dir, uid: p.linuxHost?.uid ?? process.getuid!() },
            start,
          )
      : undefined,
    deps.nativeService ? "native" : "terminal",
  );
  return {
    agent,
    control: control.server,
    p,
    cfg,
    fp,
    releaseOutput,
    stopFirstConnect,
    stopBackendDetectors,
    herdr,
  };
}

program
  .command("start", { isDefault: true })
  .description("run the agent in the foreground")
  .option("--service", "running under launchd or a systemd user service")
  .action(async (o: { service?: boolean }) => {
    let serviceInstance: string | null;
    try {
      serviceInstance = serviceInstanceFromEnvironment(o.service === true);
    } catch (err) {
      console.error(`  ${(err as Error).message}`);
      process.exit(1);
    }
    const { opts, p, log } = ctx();
    const { agent, control, cfg, fp, releaseOutput, stopBackendDetectors } = await buildAgent(
      log,
      opts.relay,
      false,
      { serviceInstance, managedService: o.service === true, paths: p },
    );
    try {
      await control.start();
    } catch (err) {
      console.error(`  ${(err as Error).message}`);
      process.exit(1);
    }
    agent.start();

    // Initial status block (Relay/iTerm2/tmux lines are updated in place as their
    // state changes -- a line per transition -- rather than only printed once).
    console.log(
      `\n  Shellbell agent v${VERSION}\n  Computer   ${cfg.computerName}  (${fpShort(fp)})`,
    );
    console.log(
      `  Relay      ${cfg.relayUrl}   ${agent.relayOnline ? "connected" : "connecting…"}`,
    );
    agent.relay.on("auth-ok", () => console.log(`  Relay      ${cfg.relayUrl}   connected`));
    agent.relay.on("down", () => console.log(`  Relay      ${cfg.relayUrl}   connecting…`));
    console.log("  tmux       detecting…"); // followed up by startTmuxBackend's onConnected line
    if (!p.linuxHost) console.log("  herdr      detecting…"); // followed up by startHerdrBackend's onConnected line
    // The header above is up: any iTerm2 line `buildAgent`'s firstConnect() queued while it was
    // still connecting can now be printed without interleaving the initial status block.
    releaseOutput();

    if (agent.pairingList.length === 0 && !o.service && process.stdin.isTTY) {
      console.log("\n  No phones paired yet. Scan this with the Shellbell app:\n");
      const { qrText, expiresAt } = agent.openPairing();
      printQr(qrText, expiresAt);
    }
    // Minor: a second Ctrl-C while shutdown is already in flight forces an immediate exit rather
    // than leaving the process to wait out a hung `control.stop()` -- shutdown() also carries its
    // own 5 s hard deadline, so this is belt-and-braces for an impatient human.
    let shuttingDown = false;
    const onSignal = () => {
      if (shuttingDown) {
        console.error("  forcing exit");
        process.exit(130);
        return;
      }
      shuttingDown = true;
      void shutdown(agent, control, process.exit, stopBackendDetectors).catch(() =>
        process.exit(1),
      );
    };
    process.on("SIGINT", onSignal);
    process.on("SIGTERM", onSignal);
  });

program
  .command("pair")
  .description("open a 5-minute pairing window and show the QR")
  .option("--yes", "auto-accept requests (unsafe on shared screens)")
  .action(async (o: { yes?: boolean }) => {
    const { opts, p, cfg, log } = ctx();
    const { fp } = loadOrCreateIdentity(p);

    const startInProcess = async () => {
      // I2: destructure this call's own (possibly --relay-overridden) cfg/fp rather than the
      // outer `ctx()` ones, so the printed header's "Relay" line always matches the QR it prints.
      const {
        agent,
        control,
        cfg: agentCfg,
        fp: agentFp,
        releaseOutput,
        stopBackendDetectors,
      } = await buildAgent(log, opts.relay, o.yes, { paths: p });
      try {
        await control.start();
      } catch (err) {
        console.error(`  ${(err as Error).message}`);
        process.exit(1);
      }
      agent.start();
      const { qrText, expiresAt } = agent.openPairing();
      printPairHeader(agentCfg, agentFp);
      printQr(qrText, expiresAt);
      releaseOutput();
      setTimeout(
        () =>
          void shutdown(agent, control, () => process.exit(0), stopBackendDetectors).catch(() =>
            process.exit(1),
          ),
        5 * 60_000 + 1000,
      );
    };

    // talks to a running agent's control socket; a dead/stale socket falls back to an
    // in-process agent rather than failing outright.
    if (!(await socketAlive(p.sock))) {
      await startInProcess();
      return;
    }

    const session = controlPairSession(p.sock, {
      onOpen: (qrText, expiresAt) => {
        printPairHeader(cfg, fp);
        printQr(qrText, expiresAt);
      },
      onRequest: (phoneFp, name) =>
        o.yes
          ? Promise.resolve(true)
          : askYesNo(`\n  Pair "${name}" (fp ${fpShort(phoneFp)})?  [y/N]  (60 s) `, 60_000),
      onClose: () => {
        console.log("  pairing window closed");
        process.exit(0);
      },
      onError: (e) => {
        console.error(`  ${e.message}`);
        process.exit(1);
      },
    });
    setTimeout(
      () => {
        session.close();
        process.exit(0);
      },
      5 * 60_000 + 1000,
    );
  });

program
  .command("status")
  .description("show agent status")
  .action(async () => {
    const { opts, p } = ctx();
    try {
      const s = await controlRequest(p.sock, "status");
      console.log(opts.json ? JSON.stringify(s) : JSON.stringify(s, null, 2));
    } catch {
      console.log(opts.json ? JSON.stringify({ running: false }) : "  agent not running");
    }
  });

function reportDeviceCommandFailure(error: unknown): void {
  const code = (error as NodeJS.ErrnoException | null)?.code;
  if (code === "ENOENT" || code === "ECONNREFUSED") console.error("  agent not running");
  else
    console.error(
      `shellbell: ${error instanceof Error ? error.message : "control request failed"}`,
    );
  process.exitCode = 2;
}

program
  .command("devices")
  .description("list paired phones")
  .action(async () => {
    const { opts, p } = ctx();
    try {
      const d = await controlRequest(p.sock, "devices");
      console.log(opts.json ? JSON.stringify(d) : JSON.stringify(d, null, 2));
    } catch (error) {
      reportDeviceCommandFailure(error);
    }
  });

program
  .command("unpair <target>")
  .description("remove a paired phone (fp prefix or name)")
  .action(async (target: string) => {
    const { p } = ctx();
    try {
      const r = (await controlRequest(p.sock, "unpair", { target })) as { removed: boolean };
      console.log(r.removed ? "  removed" : "  no such phone");
    } catch (error) {
      reportDeviceCommandFailure(error);
    }
  });

export function addServiceCommands(
  parent: Command,
  createLifecycle: () => ServiceLifecycle,
  deps: {
    platform?: NodeJS.Platform;
    createLinuxLifecycle?: () => SystemdServiceLifecycle;
  } = {},
): void {
  const service = parent.command("service").description("manage the per-user service");
  const commands = {
    status: "inspect the installed service and local readiness without starting it",
    install: "install or update the service (Linux: does not start or enable)",
    start: "start the installed definition and verify local readiness",
    stop: "stop now; retain the configured future autostart choice",
    restart: "restart the installed definition and verify the new process",
    uninstall: "remove future autostart; identity and pairings remain",
    enable: "enable future per-user startup; do not start now",
    disable: "disable owned future startup; do not stop now",
  };
  for (const [command, description] of Object.entries(commands)) {
    service
      .command(command)
      .description(description)
      .action(async () => {
        const json = parent.opts<{ json?: boolean }>().json;
        const platform = deps.platform ?? process.platform;
        const linux = platform === "linux";
        if (!linux && platform !== "darwin") {
          const message =
            "Service management supports macOS launchd and Linux systemd user managers only";
          if (json) console.log(JSON.stringify({ error: message }));
          else console.error(`  ${message}`);
          process.exitCode = 2;
          return;
        }
        try {
          if (linux) {
            const lifecycle = (
              deps.createLinuxLifecycle ?? (() => new SystemdServiceLifecycle({ env: process.env }))
            )();
            const result = await lifecycle[command as keyof typeof commands]();
            const success = ["start", "restart", "status"].includes(command)
              ? result.ready
              : command === "enable"
                ? result.enabled && result.autostartConfigured
                : command === "disable"
                  ? !result.enabled && !result.autostartConfigured
                  : command === "uninstall"
                    ? !result.installed && !result.enabled && !result.autostartConfigured
                    : command === "install"
                      ? result.installed
                      : true;
            console.log(
              json
                ? JSON.stringify(result)
                : `${JSON.stringify(result, null, 2)}\n  Future autostart: ${result.enabled ? "enabled" : "disabled"}; linger: ${result.linger}. Stop retains autostart; disable does not stop a running job.\n  Linger is an operator policy; Shellbell never enables it automatically.`,
            );
            process.exitCode = success ? 0 : 2;
            return;
          }
          const result = await createLifecycle()[command as keyof typeof commands]();
          console.log(json ? JSON.stringify(result) : JSON.stringify(result, null, 2));
          process.exitCode = command === "status" && !result.ready ? 2 : 0;
        } catch (error) {
          if (linux) {
            const message =
              error instanceof Error && error.message.startsWith("shellbell:")
                ? error.message
                : "Linux systemd service operation failed; inspect service status, host state, and the durable installed runtime before retrying";
            if (json) console.log(JSON.stringify({ error: message }));
            else console.error(`  ${message}`);
            process.exitCode = 2;
            return;
          }
          const failure =
            error instanceof ServiceLifecycleError
              ? error
              : new ServiceLifecycleError(
                  error instanceof Error ? error.message : "Service operation failed",
                );
          const output = {
            error: failure.message,
            rollback: failure.rollback,
            rollbackDiagnostic: failure.rollbackDiagnostic,
            recoveryPath: failure.recoveryPath,
          };
          if (json) console.log(JSON.stringify(output));
          else
            console.error(
              `  ${failure.message}\n  rollback: ${failure.rollback}${failure.rollbackDiagnostic ? ` — ${failure.rollbackDiagnostic}` : ""}${failure.recoveryPath ? `\n  recovery definition: ${failure.recoveryPath}` : ""}`,
            );
          process.exitCode = 2;
        }
      });
  }
}

addServiceCommands(
  program,
  () =>
    new ServiceLifecycle({
      manager: createLaunchdManager(),
      requestedStateDir: process.env.SHELLBELL_DIR || undefined,
      defaultStateDir: join(homedir(), ".shellbell"),
      env: process.env,
    }),
);

program
  .command("logs")
  .option("-f, --follow")
  .description("show the agent log")
  .action((o: { follow?: boolean }) => {
    const { p } = ctx();
    if (o.follow) spawn("tail", ["-f", p.log], { stdio: "inherit" });
    else if (existsSync(p.log)) process.stdout.write(tailFile(p.log, 64 * 1024, 200));
  });

function configActionError(message: string, json: boolean | undefined): void {
  process.exitCode = 2;
  if (json) console.log(JSON.stringify({ error: message }));
  else console.error(`  ${message}`);
}

program
  .command("config")
  .description(`config set <${CONFIG_KEYS.join("|")}> <value>`)
  .argument("<op>")
  .argument("<key>")
  .argument("<value>")
  .action((op: string, key: string, value: string) => {
    const opts = program.opts<{ json?: boolean; insecure?: boolean }>();
    if (op !== "set") {
      configActionError(`unknown config operation ${op} (expected set)`, opts.json);
      return;
    }
    const allowInsecure =
      Boolean(opts.insecure) || process.env.SHELLBELL_ALLOW_INSECURE_RELAY === "1";
    const validation = resolveConfigSet(defaultConfig(), key, value, allowInsecure);
    if ("error" in validation) {
      configActionError(validation.error, opts.json);
      return;
    }
    try {
      const p = selectAgentPaths();
      editConfig(p, (current) => {
        const result = resolveConfigSet(current, key, value, allowInsecure);
        if ("error" in result) throw new Error(result.error);
        return result.next;
      });
    } catch (error) {
      configActionError(error instanceof Error ? error.message : String(error), opts.json);
      return;
    }
    if (opts.json) console.log(JSON.stringify({ saved: true, restartRequired: true }));
    else console.log("  configuration saved; the running agent must be restarted");
  });

export function printDoctorResult(
  checks: Check[],
  json: boolean,
  write: (line: string) => void = console.log,
  exit: (code: number) => void = (code) => {
    process.exitCode = code;
  },
): void {
  const code = doctorExitCode(checks);
  if (json) write(JSON.stringify(checks));
  else
    for (const c of checks)
      write(
        `  ${c.severity === "pass" ? "✓" : c.severity === "warning" ? "!" : "✗"} ${c.name.padEnd(18)} ${c.detail}${!c.fix ? "" : `\n      fix: ${c.fix}`}`,
      );
  exit(code);
}

export interface DoctorCommandDeps {
  runDoctor?: typeof runDoctor;
  defaultStateDir?: string;
  env?: NodeJS.ProcessEnv;
}

export function addDoctorCommand(root: Command, deps: DoctorCommandDeps = {}): void {
  root
    .command("doctor")
    .description("inspect local agent, relay and terminal backend health without changing state")
    .option(
      "--require-backend [name]",
      "treat a disconnected backend as an error (repeatable)",
      (value: string | boolean, prior: string[]) => [
        ...prior,
        typeof value === "string" ? value : "",
      ],
      [] as string[],
    )
    .action(async (commandOptions: { requireBackend: string[] | boolean }) => {
      const json = Boolean(root.opts<{ json?: boolean }>().json);
      const requestedNames = new Set(
        Array.isArray(commandOptions.requireBackend) ? commandOptions.requireBackend : [""],
      );
      if ([...requestedNames].some((name) => !BACKEND_ORDER.some((valid) => valid === name))) {
        const check: Check = {
          name: "doctor arguments",
          ok: false,
          severity: "error",
          detail: "invalid required backend name",
          fix: "use iterm2, tmux, or herdr",
        };
        if (json) console.log(JSON.stringify([check]));
        else console.log(`  ✗ ${check.name}  ${check.detail}\n      fix: ${check.fix}`);
        process.exitCode = 2;
        return;
      }
      const requiredBackends = BACKEND_ORDER.filter((name) => requestedNames.has(name));
      const env = deps.env ?? process.env;
      let checks: Check[];
      try {
        checks = await (deps.runDoctor ?? runDoctor)({
          requestedStateDir: env.SHELLBELL_DIR,
          defaultStateDir: deps.defaultStateDir ?? join(homedir(), ".shellbell"),
          requiredBackends,
          env,
        });
      } catch {
        checks = [
          { name: "doctor", ok: false, severity: "error", detail: "diagnostic inspection failed" },
        ];
      }
      printDoctorResult(checks, json);
    });
}

addDoctorCommand(program);
addHostCommand(program);

// Only run the CLI when this file is the process entry point -- e.g. `node dist/cli.js` or
// `tsx src/cli.ts` -- never when a test imports the pure/exported helpers above. Compare
// realpaths, not raw strings: npm's bin is a symlink (`bin/shellbell -> ../lib/...`), and
// pnpm's store can put a symlink on either side, so both `argv1` and `selfUrl` are resolved
// before comparing (`resolvePath` is injectable so tests can fake symlink resolution without
// spawning the built bundle).
export function isEntryPoint(
  argv1: string | undefined,
  selfUrl: string,
  resolvePath: (path: string) => string = realpathSync,
): boolean {
  if (!argv1) return false;
  let entry: string;
  try {
    entry = resolvePath(argv1);
  } catch {
    entry = argv1;
  }
  const selfPath = fileURLToPath(selfUrl);
  let self: string;
  try {
    self = resolvePath(selfPath);
  } catch {
    self = selfPath;
  }
  return self === entry;
}

if (isEntryPoint(process.argv[1], import.meta.url)) {
  program.parseAsync().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
