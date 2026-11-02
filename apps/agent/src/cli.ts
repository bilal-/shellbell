#!/usr/bin/env node
import { spawn } from "node:child_process";
import { closeSync, existsSync, fstatSync, openSync, readSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { formatFingerprint, terminalNeedsAttention, terminalSetupText } from "@shellbell/protocol";
import { Command, Option } from "commander";
import qrcode from "qrcode-terminal";
import pkg from "../package.json" with { type: "json" };
import { Agent } from "./agent.js";
import {
  type AgentSetupEntry,
  agentSetupLine,
  agentSetupPaths,
  agentsToOffer,
  detectAgents,
  refreshAgentHooks,
  removeAgentSetup,
  setupAgents,
  skipAgentSetup,
} from "./agent-setup.js";
import { HerdrBackend } from "./backends/herdr/backend.js";
import { findHerdrExecutable } from "./backends/herdr/executable.js";
import { startHerdrBackend } from "./backends/herdr/start.js";
import { ITerm2Access } from "./backends/iterm2/access.js";
import { COOKIE_TIMEOUT_MS } from "./backends/iterm2/auth.js";
import { ITerm2Backend } from "./backends/iterm2/backend.js";
import { DEFAULT_SOCKET, ITerm2Client } from "./backends/iterm2/client.js";
import { startTerminalPlugins } from "./backends/plugin.js";
import { BACKEND_ORDER, BackendRegistry } from "./backends/registry.js";
import {
  herdrServerLauncher,
  macApplicationInstalled,
  macApplicationLauncher,
  waitForBackend,
} from "./backends/session-startup.js";
import {
  ghosttyWindowLauncher,
  openOrDiscard,
  type TerminalWindowLauncher,
  terminalCommandLine,
} from "./backends/terminal-launch.js";
import { type StartTmuxOptions, startTmuxBackend } from "./backends/tmux/start.js";
import {
  BackendUnavailable,
  NotShownOnComputer,
  type TerminalSetupReport,
} from "./backends/types.js";
import { type BackgroundStatus, createBackground, ensureLinuxHost } from "./background.js";
import {
  addBackgroundCommands,
  type BackgroundCommandDeps,
  describeBackground,
  installBackground,
  NO_BACKGROUND_ON_THIS_COMPUTER,
  startBackground,
} from "./background-commands.js";
import {
  type AgentConfig,
  defaultConfig,
  editConfig,
  loadConfig,
  loadPairings,
  type Paths,
  paths,
} from "./config.js";
import {
  CONFIG_KEYS,
  configRevision,
  resolveConfigSet,
  validateRelayUrl,
} from "./config-values.js";
import { useAgentStateDir } from "./conversation/agent-sessions.js";

export {
  CONFIG_KEYS,
  type ConfigKey,
  resolveConfigSet,
  validateRelayUrl,
} from "./config-values.js";

import {
  ControlServer,
  type ControlV2Client,
  connectControlV2,
  controlPairSession,
  controlRequest,
  type StatusData,
} from "./control.js";
import { type Check, doctorExitCode, runDoctor } from "./doctor.js";
import { addHostCommand, selectAgentPaths } from "./host-command.js";
import { type LinuxPaths, prepareLinuxRuntime, resolveLinuxPaths } from "./host-paths.js";
import { requireLinuxState } from "./host-state.js";
import { loadOrCreateIdentity } from "./identity.js";
import { serviceInstanceFromEnvironment } from "./local-status.js";
import { createLogger, type Logger, safeErrorName } from "./log.js";
import { cleanPhoneName, type PairingCloseReason } from "./pairing.js";
import {
  appOwnership,
  requireHeadlessEngine,
  withHeadlessEngineAdmission,
} from "./service-ownership.js";
import { SystemdServiceLifecycle } from "./systemd-lifecycle.js";
import { addUpdateCommand } from "./update-command.js";

const VERSION = pkg.version;
export const program = new Command()
  .name("shellbell")
  .version(VERSION)
  .option("--relay <url>", "override relay url")
  .option("--json", "machine output")
  .option("--verbose", "debug logging")
  .option("--insecure", "allow a ws:// relay url (LAN dev only)");

addUpdateCommand(program, VERSION);

/** This command's options, state paths, config and log. `selected` reuses paths a command
 * already chose, so one run never selects two different state folders. */
function ctx(selected?: Paths) {
  const opts = program.opts<{
    relay?: string;
    json?: boolean;
    verbose?: boolean;
    insecure?: boolean;
  }>();
  const p = selected ?? selectAgentPaths();
  const cfg = loadConfig(p);
  const log = createLogger({
    file: p.log,
    verbose: opts.verbose,
    stdout: process.stdout.isTTY && !opts.json,
  });
  return { opts, p, cfg, log };
}

const fpShort = (fp: string) => `${fp.slice(0, 4)}-${fp.slice(4, 8)}`;

/** The full fingerprint, so it can be compared with the one on the phone's waiting screen. */
function askPairPhone(phoneFp: string, name: string): Promise<boolean> {
  return askYesNo(
    `\n  Pair "${cleanPhoneName(name)}"?\n  Phone fingerprint  ${formatFingerprint(phoneFp)}\n  Check that your phone shows the same fingerprint.  [y/N]  (60 s) `,
    60_000,
  );
}

function askYesNo(question: string, timeoutMs: number, byDefault = false): Promise<boolean> {
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
      const answer = a.trim();
      resolve(answer === "" ? byDefault : /^y(es)?$/i.test(answer));
    });
  });
}

function printAgents(agents: readonly AgentSetupEntry[]): void {
  if (!agents.length) {
    console.log("  No coding agents found on this computer.");
    return;
  }
  for (const agent of agents) console.log(`  ${agent.name.padEnd(12)} ${agentSetupLine(agent)}`);
}

/**
 * Asks once, in a terminal, to add the helpers that give the phone each agent's full history.
 * Never asks without a person to answer, and never asks again about an agent that was skipped.
 */
async function offerAgentSetup(stateDir: string): Promise<void> {
  const where = agentSetupPaths(stateDir);
  const offer = agentsToOffer(detectAgents(where));
  if (!offer.length) return;
  const names = offer.map((agent) => agent.name).join(", ");
  console.log(
    `\n  Get the most out of ${names} on your phone (highly recommended)\n` +
      "  Scroll back through a whole session, not just what's on screen, in text sized for your\n" +
      "  phone. Shellbell adds a small helper to each agent. It only notes which window each\n" +
      "  session runs in, and doesn't change how the agent works. Remove it with\n" +
      "  `shellbell agents remove <name>`.",
  );
  if (offer.some((agent) => agent.kind === "codex"))
    console.log("  Codex asks you to trust the helper the next time it starts. Choose Trust.");
  const kinds = offer.map((agent) => agent.kind);
  if (await askYesNo("  Set up now? [Y/n] ", 120_000, true)) {
    try {
      printAgents(setupAgents(where, kinds).filter((agent) => kinds.includes(agent.kind)));
    } catch (error) {
      console.error(`  ${error instanceof Error ? error.message : String(error)}`);
    }
  } else {
    skipAgentSetup(where, kinds);
    console.log("  Skipped. Set up later with `shellbell agents setup`.");
  }
}

function printPairHeader(cfg: AgentConfig, fp: string): void {
  console.log(
    `\n  Computer   ${cfg.computerName}  (${fpShort(fp)})\n  Relay      ${cfg.relayUrl}\n\n  Scan this with the Shellbell app:\n`,
  );
}

/** A clock time such as `10:29`, in the computer's own time zone. */
export function pairValidUntil(expiresAt: number): string {
  return new Date(expiresAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

function printQr(qrText: string, expiresAt: number): void {
  // Above the code, so a stale code on screen is obvious before anyone scans it.
  console.log(`  Valid until ${pairValidUntil(expiresAt)}\n`);
  qrcode.generate(qrText, { small: true }, (qr) => {
    console.log(
      qr
        .split("\n")
        .map((l) => `  ${l}`)
        .join("\n"),
    );
    console.log("");
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
  herdrBackendOptions?: Parameters<typeof startHerdrBackend>[0]["backendOptions"];
  terminalWindows?: readonly TerminalWindowLauncher[];
  /** Also told when a pairing window closes, after any `pair` clients. */
  onPairingClosed?: (reason: PairingCloseReason) => void;
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
  useAgentStateDir(p.dir);
  refreshAgentHooks(agentSetupPaths(p.dir));
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
  // macOS asks "Shellbell wants to control iTerm2" only after the user clicks Connect iTerm2,
  // or right away for someone running Shellbell in a terminal. Installs that already paired a
  // phone have been through that question at every start, so they keep connecting on their own.
  const itermAccess = p.linuxHost
    ? null
    : new ITerm2Access({
        recordPath: join(p.dir, "iterm2-access.json"),
        assumeApproved: (() => {
          try {
            return loadPairings(p).length > 0;
          } catch {
            return false;
          }
        })(),
        interactive: !deps.nativeService && !deps.managedService && process.stdin.isTTY === true,
        socketPath: DEFAULT_SOCKET,
      });
  const iterm = p.linuxHost
    ? null
    : deps.itermBackend === undefined
      ? new ITerm2Backend(
          new ITerm2Client({
            log,
            cookieProvider: () => itermAccess!.cookieProvider(COOKIE_TIMEOUT_MS),
          }),
          log,
        )
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
  let lastITermIssue: string | undefined;
  const attemptFirstConnect = async () => {
    if (!iterm || firstConnectStopped) return;
    try {
      await iterm.connect();
      if (firstConnectStopped) return;
      registry.add(iterm);
      lastITermIssue = undefined;
      const sessions = await iterm.listSessions().catch(() => []);
      if (firstConnectStopped) return;
      print(
        `  iTerm2     connected · ${sessions.length} session${sessions.length === 1 ? "" : "s"}`,
      );
      log.info("iTerm2 connected");
    } catch (err) {
      if (firstConnectStopped) return;
      const issue = itermAccess?.issue ?? ("failed" as const);
      // Said once per change: the retry below runs every 10 s.
      if (issue !== lastITermIssue) {
        lastITermIssue = issue;
        const text = terminalSetupText({ name: "iterm2", connected: false, issue }, "command-line");
        print(`  iTerm2     ${text.status}${text.fix ? `\n             ${text.fix}` : ""}`);
        log.info("iTerm2 not connected", { issue, err: safeErrorName(err) });
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
  const itermLauncher =
    !p.linuxHost && deps.itermBackend === undefined ? macApplicationLauncher("iterm2") : null;
  // An iTerm2 outside the usual folders is still installed: its Open button must stay.
  const itermInstalled = itermLauncher
    ? macApplicationInstalled("com.googlecode.iterm2", itermLauncher.available, {
        onChange: () => registry.notifySetupChanged(),
      })
    : () => undefined;
  const removeITermReporter =
    iterm && itermAccess
      ? (() => {
          const stopWatching = itermAccess.onChange(() => registry.notifySetupChanged());
          const report = Object.assign(
            (connected: boolean): TerminalSetupReport =>
              iTermSetupReport(connected, itermAccess, itermInstalled),
            {
              // The one step that may make macOS and iTerm2 ask; only a person's click starts it.
              connect: () =>
                itermAccess.connect(async () => {
                  await firstConnectFlight;
                  if (!registry.connected().some((backend) => backend.name === "iterm2"))
                    await firstConnect();
                }),
            },
          );
          const unregister = registry.registerSetupReporter("iterm2", report);
          return () => {
            stopWatching();
            unregister();
          };
        })()
      : () => {};
  // herdr is optional and usually absent, so this never blocks startup and never
  // prints an error -- it registers the backend, retries every 10 s, and announces itself if and
  // when it connects. Buffered through `print` like the iTerm2 line, for the same reason.
  // tmux is optional and often absent, so this never blocks startup. It registers
  // the backend, retries every 10 s while the server is down, and announces itself if and when it
  // connects. Buffered through `print` like the iTerm2 and herdr lines, for the same reason.
  const ghosttyLauncher =
    !p.linuxHost && deps.tmuxBackendOptions === undefined ? ghosttyWindowLauncher() : null;
  /**
   * Opens iTerm2 for a phone request and waits for it. When it needs a person's approval on the
   * computer, the phone hears that in plain words at once instead of a timeout.
   */
  const readyITerm = async () => {
    await itermLauncher?.start();
    await firstConnect();
    const issue = itermAccess?.issue;
    if (
      issue &&
      !registry.connected().some((backend) => backend.name === "iterm2") &&
      terminalNeedsAttention({ name: "iterm2", connected: false, issue })
    ) {
      const { status, fix } = terminalSetupText(
        { name: "iterm2", connected: false, issue },
        "phone",
      );
      throw new NotShownOnComputer(`${status} ${fix ?? ""}`.trim());
    }
    await waitForBackend(registry, "iterm2");
  };
  const terminalWindows: readonly TerminalWindowLauncher[] = deps.terminalWindows ?? [
    ...(ghosttyLauncher ? [ghosttyLauncher] : []),
    ...(iterm && itermLauncher
      ? [
          {
            id: "iterm2",
            label: "iTerm2",
            available: itermLauncher.available,
            async launch(command: Parameters<TerminalWindowLauncher["launch"]>[0]) {
              if (!registry.connected().some((backend) => backend.name === "iterm2"))
                await readyITerm();
              if (registry.member("iterm2") !== iterm)
                throw new BackendUnavailable("iTerm2 was replaced", "Reconnect your computer.");
              if (command.initialSize)
                await iterm.createCommandSession(terminalCommandLine(command), command.initialSize);
              else await iterm.createCommandSession(terminalCommandLine(command));
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
        ...(deps.herdrBackendOptions ? { backendOptions: deps.herdrBackendOptions } : {}),
      });
  // Minor: without this, the retry timer above outlives `stop()`/`shutdown()` -- harmless for the
  // CLI (every shutdown path calls `process.exit`) but it means `buildAgent` can't be reused in a
  // long-lived host. `shutdown()` calls this as its `cleanup` step.
  const stopFirstConnect = () => {
    removeITermReporter();
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
          await readyITerm();
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
            // Only a running Herdr is worth explaining; people without Herdr see nothing.
            unavailableReason: () => {
              const member = registry.member("herdr");
              return host.available() && member instanceof HerdrBackend
                ? member.terminalAttachIssue
                : undefined;
            },
            create: async (backend, _firstId, size) => {
              const executable =
                backend instanceof HerdrBackend ? backend.terminalAttachExecutable : undefined;
              if (!executable || !(backend instanceof HerdrBackend))
                throw new BackendUnavailable(
                  "Herdr terminal attach is unavailable",
                  "Use matching Herdr CLI/server versions, 0.9.3 or newer.",
                );
              const { terminalId: id, workspaceId } = await backend.createWorkspace();
              await openOrDiscard(
                async () => {
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
                    ...(size ? { initialSize: size } : {}),
                    args: ["terminal", "attach", id],
                    environment: { HERDR_SOCKET_PATH: backend.terminalSocketPath },
                  });
                  // The app started; the session is shown only once its window attached.
                  if (!(await backend.waitForVisibleAttach(id)))
                    throw new BackendUnavailable(
                      "terminal window did not attach",
                      "Unlock your computer and try again.",
                    );
                },
                async () => {
                  if (!workspaceId) throw new Error("Herdr workspace id unknown");
                  await backend.closeWorkspace(workspaceId);
                },
              );
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
      (phoneFp, name) => askPairPhone(phoneFp, name),
      !deps.nativeService,
    ),
    onPairingClosed: (reason) => {
      control.server?.notifyClosed(reason);
      deps.onPairingClosed?.(reason);
    },
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

/** Shellbell in this process: the background service's own entry, or `run` in a terminal. */
async function runInThisWindow(o: { service?: boolean; paths?: Paths }): Promise<void> {
  let serviceInstance: string | null;
  try {
    serviceInstance = serviceInstanceFromEnvironment(o.service === true);
  } catch (err) {
    console.error(`  ${(err as Error).message}`);
    process.exit(1);
  }
  const { opts, p, log } = ctx(o.paths);
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
  console.log(`\n  Shellbell ${VERSION}\n  Computer   ${cfg.computerName}  (${fpShort(fp)})`);
  console.log(`  Relay      ${cfg.relayUrl}   ${agent.relayOnline ? "connected" : "connecting…"}`);
  agent.relay.on("auth-ok", () => console.log(`  Relay      ${cfg.relayUrl}   connected`));
  agent.relay.on("down", () => console.log(`  Relay      ${cfg.relayUrl}   connecting…`));
  console.log("  tmux       detecting…"); // followed up by startTmuxBackend's onConnected line
  if (!p.linuxHost) console.log("  herdr      detecting…"); // followed up by startHerdrBackend's onConnected line
  // The header above is up: any iTerm2 line `buildAgent`'s firstConnect() queued while it was
  // still connecting can now be printed without interleaving the initial status block.
  releaseOutput();

  if (!o.service && process.stdin.isTTY && !opts.json) await offerAgentSetup(p.dir);
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
    void shutdown(agent, control, process.exit, stopBackendDetectors).catch(() => process.exit(1));
  };
  process.on("SIGINT", onSignal);
  process.on("SIGTERM", onSignal);
  if (!o.service && process.stdin.isTTY && !opts.json) console.log(`\n  ${IN_THIS_WINDOW}`);
}

export const IN_THIS_WINDOW =
  "Shellbell is running in this window, so your phone can reach this computer until you close it or press Ctrl-C. Run `shellbell install` to keep Shellbell running in the background instead.";

const OFFER_BACKGROUND =
  "\n  Run Shellbell in the background? (highly recommended)\n  Your phone can then reach this computer whenever it's on and you're logged in, without a\n  terminal window open.  [Y/n] ";

/** The Mac app's own words when it runs Shellbell here, printed instead of changing anything. */
function appRunsShellbell(): boolean {
  if (process.platform !== "darwin") return false;
  const reason = appOwnership({ stateDir: selectAgentPaths().dir, uid: process.getuid!() });
  if (reason) console.log(`  ${reason}`);
  return reason !== null;
}

/** This computer's state paths, chosen once, before its Linux state may exist. */
function thisComputer(): Paths {
  return process.platform === "linux" ? resolveLinuxPaths() : paths();
}

/** Makes this Linux computer's identity when it has none, without touching one kept elsewhere. */
async function prepareThisComputer(p: Paths): Promise<void> {
  if (!p.linuxHost) return;
  let installedStateDir: string | null = null;
  try {
    installedStateDir =
      (await new SystemdServiceLifecycle({ env: process.env }).installedRuntime())?.stateDir ??
      null;
  } catch {
    // No readable unit: nothing pins the state folder elsewhere.
  }
  await ensureLinuxHost(p as LinuxPaths, { installedStateDir });
}

/** Whether any Shellbell, background or in a window, answers on this computer. */
async function shellbellAnswers(p?: Paths): Promise<boolean> {
  try {
    return await socketAlive((p ?? selectAgentPaths()).sock);
  } catch {
    return false;
  }
}

/** The background Shellbell's state, or undefined where it can't be asked. */
async function backgroundState(): Promise<BackgroundStatus | undefined> {
  if (process.platform !== "darwin" && process.platform !== "linux") return undefined;
  try {
    return await createBackground().status();
  } catch {
    return undefined;
  }
}

function backgroundDeps(): BackgroundCommandDeps {
  return {
    background: () => createBackground(),
    version: VERSION,
    offerAgents: async () => {
      if (process.stdin.isTTY) await offerAgentSetup(selectAgentPaths().dir);
    },
    afterInstall: async () => {
      if (!process.stdin.isTTY) return;
      const { p } = ctx();
      if (loadPairings(p).length === 0) await pairWithRunningShellbell(false);
    },
    otherCopyRunning: shellbellAnswers,
    appOwned: appRunsShellbell,
  };
}

/** Pairs a phone through the Shellbell that already answers here, and says how it ended. */
async function pairWithRunningShellbell(yes: boolean): Promise<number> {
  const { p, cfg } = ctx();
  const { fp } = loadOrCreateIdentity(p);
  let running: { process?: { serviceInstance?: string | null } } | undefined;
  try {
    running = (await controlRequest(p.sock, "status")) as typeof running;
  } catch {
    running = undefined;
  }
  return new Promise((resolve) => {
    let approved = "";
    const session = controlPairSession(p.sock, {
      onOpen: (qrText, expiresAt) => {
        printPairHeader(cfg, fp);
        printQr(qrText, expiresAt);
      },
      onRequest: async (phoneFp, name) => {
        const accept = yes || (await askPairPhone(phoneFp, name));
        if (accept) approved = cleanPhoneName(name);
        return accept;
      },
      onClose: (reason) => {
        clearTimeout(timer);
        if (reason === "replaced")
          console.log("  This code has been replaced by a newer one. Scan the new code instead.");
        else if (reason !== "paired") console.log("  pairing window closed");
        else if (running?.process?.serviceInstance === null)
          console.log(
            `  Paired with ${approved || "your phone"}. Shellbell is running in a terminal window, so your phone can reach this computer only while that window stays open. Run \`shellbell install\` to keep it running in the background.`,
          );
        else console.log(`  Paired with ${approved || "your phone"}. You're all set.`);
        session.close();
        resolve(reason === "paired" ? 0 : 1);
      },
      onError: (e) => {
        clearTimeout(timer);
        console.error(`  ${e.message}`);
        resolve(1);
      },
    });
    const timer = setTimeout(
      () => {
        session.close();
        resolve(1);
      },
      5 * 60_000 + 1000,
    );
  });
}

/** Pairs through a Shellbell started in this process, for a computer that won't run it in the
 * background. After a phone pairs, it keeps running until Ctrl-C instead of quietly stopping. */
async function pairInThisWindow(
  yes: boolean,
  opts: { relay?: string },
  selected: Paths,
): Promise<void> {
  const { p, log } = ctx(selected);
  let paired = false;
  let expire: ReturnType<typeof setTimeout> | undefined;
  let built: Awaited<ReturnType<typeof buildAgent>> | undefined;
  const stop = (code: number) =>
    built
      ? void shutdown(
          built.agent,
          built.control,
          () => process.exit(code),
          built.stopBackendDetectors,
        ).catch(() => process.exit(1))
      : process.exit(code);
  built = await buildAgent(log, opts.relay, yes, {
    paths: p,
    onPairingClosed: (reason) => {
      if (reason !== "paired") {
        if (!paired) {
          console.log("  pairing window closed");
          stop(0);
        }
        return;
      }
      paired = true;
      clearTimeout(expire);
      const name = built?.agent.pairingList.at(-1)?.name;
      console.log(
        `  Paired with ${name ? cleanPhoneName(name) : "your phone"}.\n\n  ${IN_THIS_WINDOW}`,
      );
    },
  });
  const { agent, control, cfg, fp, releaseOutput } = built;
  try {
    await control.start();
  } catch (err) {
    console.error(`  ${(err as Error).message}`);
    process.exit(1);
  }
  agent.start();
  const { qrText, expiresAt } = agent.openPairing();
  printPairHeader(cfg, fp);
  printQr(qrText, expiresAt);
  releaseOutput();
  expire = setTimeout(() => stop(0), 5 * 60_000 + 1000);
  let stopping = false;
  const onSignal = () => {
    if (stopping) process.exit(130);
    stopping = true;
    stop(0);
  };
  process.on("SIGINT", onSignal);
  process.on("SIGTERM", onSignal);
}

program
  .command("start", { isDefault: true })
  .description("start Shellbell, offering to run it in the background")
  .addOption(new Option("--service", "the background service's own entry").hideHelp())
  .action(async (o: { service?: boolean }) => {
    if (o.service) return runInThisWindow(o);
    const json = Boolean(program.opts<{ json?: boolean }>().json);
    if (appRunsShellbell()) return;
    const deps = backgroundDeps();
    const state = await backgroundState();
    if (state?.installed) {
      process.exitCode = await startBackground(deps, json);
      return;
    }
    const p = thisComputer();
    if (await shellbellAnswers(p)) {
      console.log("  Shellbell is already running in a terminal window.");
      return;
    }
    if (state?.available && process.stdin.isTTY && !json) {
      console.log("\n  Shellbell isn't set up to run in the background on this computer yet.");
      if (await askYesNo(OFFER_BACKGROUND, 120_000, true)) {
        process.exitCode = await installBackground(deps, json);
        return;
      }
    } else if (state && !state.available && !json)
      console.log(`  ${NO_BACKGROUND_ON_THIS_COMPUTER}`);
    await prepareThisComputer(p);
    return runInThisWindow({ paths: p });
  });

program
  .command("run")
  .description("run Shellbell in this window only, for containers and testing")
  .action(async () => {
    if (appRunsShellbell()) return;
    const p = thisComputer();
    await prepareThisComputer(p);
    return runInThisWindow({ paths: p });
  });

program
  .command("pair")
  .description("pair a phone: shows a QR code to scan with the Shellbell app")
  .option("--yes", "auto-accept requests (unsafe on shared screens)")
  .action(async (o: { yes?: boolean }) => {
    const opts = program.opts<{ relay?: string; json?: boolean }>();
    const yes = Boolean(o.yes);
    if (appRunsShellbell()) return;
    const p = thisComputer();
    if (await shellbellAnswers(p)) {
      process.exitCode = await pairWithRunningShellbell(yes);
      return;
    }
    const state = await backgroundState();
    const deps = backgroundDeps();
    if (state?.installed) {
      if ((await startBackground(deps, Boolean(opts.json))) === 0)
        process.exitCode = await pairWithRunningShellbell(yes);
      else process.exitCode = 2;
      return;
    }
    if (state?.available && process.stdin.isTTY && !opts.json) {
      console.log("\n  Shellbell isn't running in the background on this computer yet.");
      if (await askYesNo(OFFER_BACKGROUND, 120_000, true)) {
        const code = await installBackground({ ...deps, afterInstall: undefined }, false);
        process.exitCode = code === 0 ? await pairWithRunningShellbell(yes) : code;
        return;
      }
    } else if (!process.stdin.isTTY)
      console.error(
        "  Shellbell isn't running in the background, so this pairing lasts only while this command runs. Run `shellbell install` first.",
      );
    await prepareThisComputer(p);
    await pairInThisWindow(yes, opts, p);
  });

const TERMINAL_NAMES: Record<string, string> = { iterm2: "iTerm2", tmux: "tmux", herdr: "Herdr" };

/** Where Shellbell stands, in plain words: how it runs, phones, terminals and the relay. */
program
  .command("status")
  .description("show whether Shellbell is running, and its phones and terminals")
  .action(async () => {
    const json = Boolean(program.opts<{ json?: boolean }>().json);
    let background: BackgroundStatus | null = null;
    let backgroundSystem: "macos" | "linux" | null = null;
    try {
      if (process.platform === "darwin" || process.platform === "linux") {
        const b = createBackground();
        backgroundSystem = b.system;
        background = await b.status();
      }
    } catch {
      background = null;
    }
    let running: StatusData | null = null;
    try {
      running = (await controlRequest(selectAgentPaths().sock, "status")) as StatusData;
    } catch {
      running = null;
    }
    process.exitCode = running ? 0 : 2;
    if (json) {
      console.log(JSON.stringify({ background, running }));
      return;
    }
    if (appRunsShellbell()) return;
    if (!running) {
      for (const line of background && backgroundSystem
        ? describeBackground(background, backgroundSystem)
        : ["Shellbell isn't running. Run `shellbell start`."])
        console.log(`  ${line}`);
      return;
    }
    if (background?.running && backgroundSystem)
      for (const line of describeBackground(background, backgroundSystem)) console.log(`  ${line}`);
    else
      console.log(
        `  Shellbell ${running.process.agentVersion} is running in a terminal window, so it stops when that window closes. Run \`shellbell install\` to keep it running in the background.`,
      );
    const connected = new Set(running.connected.map((phone) => phone.phoneFp));
    const phones = running.phones.map(
      (phone) =>
        `${cleanPhoneName(phone.name)}${connected.has(phone.phoneFp) ? " (connected)" : ""}`,
    );
    const terminals = running.backends
      .filter((backend) => backend.connected)
      .map((backend) => TERMINAL_NAMES[backend.name] ?? backend.name);
    console.log(`  Phones     ${phones.join(", ") || "none yet. Run `shellbell pair`."}`);
    console.log(
      `  Terminals  ${terminals.join(", ") || "none ready. Run `shellbell doctor` to see why."}`,
    );
    console.log(`  Relay      ${running.relayOnline ? "connected" : "connecting…"}`);
  });

function reportDeviceCommandFailure(error: unknown): void {
  const code = (error as NodeJS.ErrnoException | null)?.code;
  if (code === "ENOENT" || code === "ECONNREFUSED")
    console.error("  Shellbell isn't running. Run `shellbell start`.");
  else
    console.error(
      `shellbell: ${error instanceof Error ? error.message : "control request failed"}`,
    );
  process.exitCode = 2;
}

program
  .command("phones")
  .alias("devices")
  .description("list paired phones")
  .action(async () => {
    const { opts, p } = ctx();
    const phones = loadPairings(p);
    let connected = new Set<string>();
    try {
      const status = (await controlRequest(p.sock, "status")) as StatusData;
      connected = new Set(status.connected.map((phone) => phone.phoneFp));
    } catch {
      // Not running: the list still comes from this computer's saved pairings.
    }
    if (opts.json) {
      console.log(
        JSON.stringify(
          phones.map((phone) => ({
            phoneFp: phone.phoneFp,
            name: phone.name,
            pairedAt: phone.pairedAt,
            lastSeenAt: phone.lastSeenAt,
            connected: connected.has(phone.phoneFp),
          })),
        ),
      );
      return;
    }
    if (!phones.length) console.log("  No phones paired yet. Run `shellbell pair`.");
    for (const phone of phones)
      console.log(
        `  ${cleanPhoneName(phone.name).padEnd(20)} ${connected.has(phone.phoneFp) ? "connected" : phone.lastSeenAt ? `last seen ${new Date(phone.lastSeenAt).toLocaleString()}` : "not seen yet"}   ${fpShort(phone.phoneFp)}`,
      );
  });

/**
 * iTerm2's line in the terminal list. A closed iTerm2 that is not in an Applications folder is
 * reported as missing, so a Mac with no usable terminal can say so. Anything iTerm2 itself
 * reported, such as its Python API being off, wins: it is running, wherever it is installed.
 * `installed` is asked only for a closed iTerm2; it is unknown when the app is not looked up.
 */
export function iTermSetupReport(
  connected: boolean,
  access: Pick<ITerm2Access, "connecting" | "issue">,
  installed: () => boolean | undefined,
): TerminalSetupReport {
  if (connected) return {};
  if (access.connecting) return { issue: "connecting" };
  const issue = access.issue ?? "not-running";
  return issue === "not-running" && installed() === false ? { issue: "not-installed" } : { issue };
}

/** Waits until a requested connection settles, then prints each terminal in plain words. */
export async function connectTerminalCommand(
  client: Pick<ControlV2Client, "connectTerminal" | "terminals">,
  name: string,
  options: { log?: (line: string) => void; pollMs?: number; timeoutMs?: number } = {},
): Promise<number> {
  const log = options.log ?? console.log;
  const started = await client.connectTerminal(name);
  if (!started) {
    log("  Update Shellbell on this computer to connect terminals from the command line.");
    return 2;
  }
  if (!started.started) {
    log(`  ${name} has no connection step. Run shellbell doctor to see its status.`);
    return 2;
  }
  log("  macOS may ask to let Shellbell control iTerm2, and iTerm2 may ask to allow Shellbell.");
  const deadline = Date.now() + (options.timeoutMs ?? COOKIE_TIMEOUT_MS + 10_000);
  let terminals = started.terminals;
  while (terminals.find((t) => t.name === name)?.issue === "connecting" && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, options.pollMs ?? 500));
    terminals = (await client.terminals()) ?? terminals;
  }
  const setup = terminals.find((t) => t.name === name);
  if (!setup) return 2;
  const { status, fix } = terminalSetupText(setup, "command-line");
  log(`  ${status}`);
  if (fix) log(`  ${fix}`);
  return setup.connected && !setup.issue ? 0 : 2;
}

program
  .command("connect <terminal>")
  .description("connect a terminal that needs your approval, such as iterm2")
  .action(async (terminal: string) => {
    const { p } = ctx();
    let client: ControlV2Client | undefined;
    try {
      client = await connectControlV2(p.sock);
      process.exitCode = await connectTerminalCommand(client, terminal);
    } catch (error) {
      reportDeviceCommandFailure(error);
    } finally {
      client?.close();
    }
  });

program
  .command("agents [action] [name]")
  .description(
    "list coding agents, or set them up for full history: agents [setup [name] | remove <name>]",
  )
  .action((action: string | undefined, name: string | undefined) => {
    const { opts, p } = ctx();
    const where = agentSetupPaths(p.dir);
    const valid =
      action === undefined || action === "setup" || (action === "remove" && name !== undefined);
    if (!valid) {
      process.exitCode = 2;
      console.error("  usage: shellbell agents [setup [name] | remove <name>]");
      return;
    }
    try {
      const known = detectAgents(where);
      const kind =
        name &&
        known.find((agent) => [agent.kind, agent.name.toLowerCase()].includes(name.toLowerCase()))
          ?.kind;
      if (name && !kind) {
        process.exitCode = 2;
        console.error(`  Shellbell didn't find ${name} on this computer.`);
        return;
      }
      const agents =
        action === "setup"
          ? setupAgents(where, kind ? [kind] : undefined)
          : action === "remove"
            ? removeAgentSetup(where, kind!)
            : known;
      if (opts.json) console.log(JSON.stringify({ agents }));
      else printAgents(agents);
      if (action === undefined && !opts.json && agentsToOffer(agents).length)
        console.log("\n  Run `shellbell agents setup` for full history on your phone.");
    } catch (error) {
      process.exitCode = 2;
      console.error(`  ${error instanceof Error ? error.message : String(error)}`);
    }
  });

// Shipped in 0.12.0 as `integration install codex`; kept so earlier instructions still work.
program
  .command("integration <action> <agent>", { hidden: true })
  .action((action: string, agent: string) => {
    if (agent !== "codex" || !["install", "uninstall", "status"].includes(action)) {
      process.exitCode = 2;
      console.error("  usage: shellbell agents [setup [name] | remove <name>]");
      return;
    }
    const where = agentSetupPaths(ctx().p.dir);
    try {
      printAgents(
        (action === "install"
          ? setupAgents(where, ["codex"])
          : action === "uninstall"
            ? removeAgentSetup(where, "codex")
            : detectAgents(where)
        ).filter((entry) => entry.kind === "codex"),
      );
    } catch (error) {
      process.exitCode = 2;
      console.error(`  ${error instanceof Error ? error.message : String(error)}`);
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

addBackgroundCommands(program, backgroundDeps());

program
  .command("logs")
  .option("-f, --follow")
  .description("show Shellbell's log")
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
  .action(async (op: string, key: string, value: string) => {
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
    let conversationApplied = false;
    let restartRequired = true;
    try {
      const p = selectAgentPaths();
      const saved = editConfig(p, (current) => {
        const result = resolveConfigSet(current, key, value, allowInsecure);
        if ("error" in result) throw new Error(result.error);
        return result.next;
      });
      if (key === "conversations") {
        let client: ControlV2Client | undefined;
        try {
          client = await connectControlV2(p.sock);
          if (client.runtime.stateDir === realpathSync(p.dir)) {
            const applied = await client.applyConversationSetting(configRevision(saved));
            conversationApplied = applied !== null;
            restartRequired = applied !== configRevision(saved);
          }
        } catch {
          // Saving succeeded. Never claim live consent changed without the authenticated reply.
        } finally {
          client?.close();
        }
      }
    } catch (error) {
      configActionError(error instanceof Error ? error.message : String(error), opts.json);
      return;
    }
    if (opts.json)
      console.log(
        JSON.stringify({
          saved: true,
          restartRequired,
          ...(key === "conversations" ? { conversationApplied } : {}),
        }),
      );
    else if (key === "conversations" && !conversationApplied)
      console.log(
        "  configuration saved; live conversation consent could not be confirmed. Restart the agent if it is running.",
      );
    else if (!restartRequired)
      console.log("  conversation consent saved and applied to the running agent");
    else if (conversationApplied)
      console.log(
        "  conversation consent applied; other saved settings still need an agent restart",
      );
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
    .description("check Shellbell, the relay and terminals without changing anything")
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
    // Shellbell's own errors are sentences for the person who ran the command.
    if (err instanceof Error && !program.opts<{ verbose?: boolean }>().verbose)
      console.error(`  ${err.message.replace(/^shellbell: /, "")}`);
    else console.error(err);
    process.exit(1);
  });
}
