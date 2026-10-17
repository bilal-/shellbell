import { type Logger, safeErrorName } from "../../log.js";
import { findTerminalExecutable } from "../executable.js";
import type { BackendRegistry } from "../registry.js";
import { openOrDiscard, type TerminalWindowLauncher } from "../terminal-launch.js";
import { BackendUnavailable } from "../types.js";
import { TmuxBackend, type TmuxBackendOptions } from "./backend.js";

export interface StartTmuxOptions {
  registry: BackendRegistry;
  log: Logger;
  /** retry every 10 s while the backend is absent. */
  retryMs?: number;
  /** Called once, with the pane count, when the backend connects — for the CLI's start banner. */
  onConnected?: (panes: number) => void;
  /** Called once, after the very first failed attempt, so the CLI's banner line resolves instead
   * of hanging. The retry loop keeps going regardless — this fires exactly once. */
  onUnavailable?: () => void;
  /** Longest wait for a phone-opened session's desktop window to attach. */
  attachTimeoutMs?: number;
  backendOptions?: Omit<Partial<TmuxBackendOptions>, "log">;
  terminalWindows?: readonly TerminalWindowLauncher[];
  terminalExecutable?: () => string | undefined;
}

/**
 * try tmux at startup, every 10 s while it is not running, and again whenever a
 * connected server dies (`isConnected` goes false when the last control client exits).
 *
 * The backend is registered with the registry BEFORE `connect()` (same as Herdr):
 * `connect()` emits `layout-changed` for the panes it discovers, and that must reach the Agent,
 * which only subscribes through the registry. A registered-but-disconnected member reports
 * `isConnected: false`, so it is not advertised in `hello.backends` until it is real. tmux not
 * running is a perfectly normal state, so failures log at debug, never as errors.
 */
export function startTmuxBackend(opts: StartTmuxOptions): { stop(): void } {
  const log = opts.log.child({ unit: "tmux-start" });
  const findExecutable = opts.terminalExecutable ?? (() => findTerminalExecutable("tmux"));
  // The service's PATH can leave out per-user installs such as ~/.local/bin. Every tmux the
  // service runs (commands, control clients, raw streams, windows) uses the program found now,
  // so one installed while the service runs is found too.
  const program = () => findExecutable() ?? "tmux";
  const backend = new TmuxBackend({ log: opts.log, executable: program, ...opts.backendOptions });
  let removeLauncher: (() => void) | undefined;
  const removeHostedLaunchers: (() => void)[] = [];
  let timer: NodeJS.Timeout | null = null;
  let stopped = false;
  let announced = false;
  let announcedUnavailable = false;

  opts.registry.add(backend);
  const removeReporter = opts.registry.registerSetupReporter("tmux", (connected) =>
    connected ? {} : { issue: backend.setupIssue ?? "no-session" },
  );
  let launchers: "none" | "checking" | "registered" = "none";
  /** Registers the launchers once tmux is found, at startup or after it is installed. */
  const registerLaunchers = (): void => {
    if (launchers !== "none" || stopped) return;
    launchers = "checking";
    void TmuxBackend.detect(opts.backendOptions?.execImpl, {
      requireServer: false,
      executable: program(),
    })
      .then((detected) => {
        if (stopped || !detected.ok) {
          launchers = "none";
          return;
        }
        launchers = "registered";
        removeLauncher = opts.registry.registerSessionLauncher("tmux", {
          available: () => !stopped,
          start: async () => ({ backend, sessionId: await backend.createFirstSession() }),
        });
        for (const host of opts.terminalWindows ?? []) {
          removeHostedLaunchers.push(
            opts.registry.registerHostedLauncher(
              { backend: "tmux", host: host.id, label: host.label },
              {
                available: () => !stopped && host.available() && findExecutable() !== undefined,
                create: async (current, firstId) => {
                  if (stopped || current !== backend)
                    throw new BackendUnavailable(
                      "tmux was replaced",
                      "Try again after the service reconnects.",
                    );
                  const installed = findExecutable();
                  if (!installed)
                    throw new BackendUnavailable(
                      "tmux is not installed",
                      "Install tmux 3.2 or newer.",
                    );
                  const id = firstId ?? (await backend.createFirstSession());
                  // Until the session id is known, the new session's only pane identifies it.
                  let created = id;
                  await openOrDiscard(
                    async () => {
                      const target = await backend.hostedSessionTarget(id);
                      created = target.sessionId;
                      if (stopped)
                        throw new BackendUnavailable("tmux stopped", "Reconnect your computer.");
                      await host.launch({
                        executable: installed,
                        args: [
                          ...(target.socketName ? ["-L", target.socketName] : []),
                          "attach-session",
                          "-t",
                          target.sessionId,
                        ],
                      });
                      // The app started; the session is shown only once its window attached.
                      if (
                        !(await backend.waitForVisibleClient(target.sessionId, {
                          timeoutMs: opts.attachTimeoutMs,
                        }))
                      )
                        throw new BackendUnavailable(
                          "terminal window did not attach",
                          "Unlock your computer and try again.",
                        );
                    },
                    () => backend.discardHostedSession(created),
                  );
                  return id;
                },
              },
            ),
          );
        }
      })
      .catch((error) => {
        launchers = "none";
        log.debug("tmux startup discovery failed", { error: safeErrorName(error) });
      });
  };
  registerLaunchers();

  const schedule = (): void => {
    if (stopped || timer) return;
    timer = setTimeout(() => {
      timer = null;
      void attempt();
    }, opts.retryMs ?? 10_000);
    timer.unref?.();
  };

  const attempt = async (): Promise<void> => {
    if (stopped) return;
    if (backend.isConnected) {
      // Already up: keep supervising so a dead server is noticed and re-detected.
      schedule();
      return;
    }
    try {
      await backend.connect();
    } catch (err) {
      registerLaunchers();
      // Log the error NAME only: `BackendUnavailable`'s message can embed tmux's own text.
      log.debug("tmux not available", { error: safeErrorName(err) });
      if (opts.onUnavailable && !announcedUnavailable && err instanceof BackendUnavailable) {
        announcedUnavailable = true;
        opts.onUnavailable();
      }
      schedule();
      return;
    }
    // A separate try/catch so a throw from `onConnected` (the CLI's buffered `print` closure)
    // cannot become an unhandled rejection, and so a failure here does not re-schedule a retry
    // as if the connect itself had failed.
    try {
      if (stopped) return;
      registerLaunchers();
      log.info("tmux connected");
      if (opts.onConnected && !announced) {
        announced = true;
        const panes = await backend.listSessions().catch(() => []);
        opts.onConnected(panes.length);
      }
    } catch (err) {
      log.debug("tmux post-connect setup failed", {
        error: safeErrorName(err),
      });
    }
    schedule();
  };

  void attempt();

  return {
    stop(): void {
      removeReporter();
      removeLauncher?.();
      for (const remove of removeHostedLaunchers) remove();
      stopped = true;
      if (timer) clearTimeout(timer);
      timer = null;
      void backend.close();
      // A long-lived host must not keep a dead member registered forever.
      opts.registry.remove("tmux");
    },
  };
}
