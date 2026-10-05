import { type Logger, safeErrorName } from "../../log.js";
import type { BackendRegistry } from "../registry.js";
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
  backendOptions?: Omit<Partial<TmuxBackendOptions>, "log">;
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
  const backend = new TmuxBackend({ log: opts.log, ...opts.backendOptions });
  let removeLauncher: (() => void) | undefined;
  let timer: NodeJS.Timeout | null = null;
  let stopped = false;
  let announced = false;
  let announcedUnavailable = false;

  opts.registry.add(backend);
  void TmuxBackend.detect(opts.backendOptions?.execImpl, { requireServer: false })
    .then((detected) => {
      if (stopped || !detected.ok) return;
      removeLauncher = opts.registry.registerSessionLauncher("tmux", {
        available: () => !stopped,
        start: async () => ({ backend, sessionId: await backend.createFirstSession() }),
      });
    })
    .catch((error) => log.debug("tmux startup discovery failed", { error: safeErrorName(error) }));

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
      removeLauncher?.();
      stopped = true;
      if (timer) clearTimeout(timer);
      timer = null;
      void backend.close();
      // A long-lived host must not keep a dead member registered forever.
      opts.registry.remove("tmux");
    },
  };
}
