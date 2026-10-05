import { existsSync } from "node:fs";
import { createLogger, type Logger, safeErrorName } from "../../log.js";
import type { BackendRegistry } from "../registry.js";
import { BackendUnavailable } from "../types.js";
import { HerdrBackend, type HerdrBackendOptions } from "./backend.js";
import {
  HerdrClient,
  HerdrError,
  INSTALL_HINT,
  UNSUPPORTED_CODES,
  UPGRADE_HINT,
} from "./client.js";
import { findHerdrExecutable } from "./executable.js";
import type { SessionSnapshotResult } from "./types.js";

/** Legacy setup-probe result; doctor maps it to pass/warning/error diagnostic severity. */
export interface HerdrCheck {
  name: string;
  ok: boolean;
  detail: string;
  fix?: string;
}

export interface CheckHerdrOptions {
  /** Optional so `doctor.ts`, which has no Logger, can call `checkHerdr()` with no arguments. */
  log?: Logger;
  socketPath?: string;
  client?: HerdrClient;
  /** Injectable so tests can drive both no-socket states without touching the real `$PATH`. */
  herdrOnPath?: () => boolean;
}

/**
 * Herdr creates its socket only while it is running, so a missing socket cannot by itself tell
 * "never installed" from "installed but stopped" — and telling someone who has herdr that it is
 * not installed sends them to reinstall what they already have. The binary on `$PATH` is what
 * separates the two. Best-effort by design: both states are a PASS, so a
 * wrong guess here changes wording, never the exit code.
 */
function herdrOnDefaultPath(env: NodeJS.ProcessEnv = process.env): boolean {
  return findHerdrExecutable(env) !== undefined;
}

/**
 *: Herdr is OPTIONAL. `doctor` exits 1 if any check fails, so "not installed"
 * has to be a passing check — only a Herdr that is actually running and cannot be used is a
 * failure. When it is usable the line reads `herdr: v0.8.2 protocol 22`.
 */
export async function checkHerdr(opts: CheckHerdrOptions = {}): Promise<HerdrCheck> {
  const log = opts.log ?? createLogger({ stdout: false });
  const client =
    opts.client ?? new HerdrClient({ log, socketPath: opts.socketPath, requestTimeoutMs: 3000 });
  if (!existsSync(client.socketPath))
    return {
      name: "herdr",
      ok: true,
      detail: (opts.herdrOnPath ?? herdrOnDefaultPath)()
        ? "installed but not running (optional)"
        : "not installed (optional)",
    };
  let pong: { version?: string; protocol?: number };
  try {
    pong = await client.ping();
  } catch (err) {
    if (err instanceof BackendUnavailable)
      return { name: "herdr", ok: false, detail: err.message, fix: err.hint };
    return { name: "herdr", ok: false, detail: String(err), fix: INSTALL_HINT };
  }
  // Gate 2: the method that actually matters. `protocol` proves nothing about it.
  try {
    await client.request<SessionSnapshotResult>("session.snapshot", {});
  } catch (err) {
    const detail =
      err instanceof HerdrError && UNSUPPORTED_CODES.has(err.code)
        ? `herdr ${pong.version ?? "?"} has no session.snapshot`
        : `session.snapshot failed: ${err instanceof Error ? err.message : String(err)}`;
    return { name: "herdr", ok: false, detail, fix: UPGRADE_HINT };
  }
  return {
    name: "herdr",
    ok: true,
    detail: `v${pong.version ?? "?"} protocol ${pong.protocol ?? "?"}`,
  };
}

export interface StartHerdrOptions {
  registry: BackendRegistry;
  log: Logger;
  socketPath?: string;
  client?: HerdrClient;
  /** retry every 10 s while the backend is absent. */
  retryMs?: number;
  /** Called once, with the pane count, when the backend connects — for the CLI's start banner. */
  onConnected?: (sessions: number) => void;
  /** Called once, after the very first connect attempt fails, so the CLI's `detecting…` banner
   * line resolves instead of hanging forever when Herdr just isn't running. The retry loop keeps
   * going regardless — this fires exactly once, not on every failed retry. */
  onUnavailable?: () => void;
  backendOptions?: Omit<Partial<HerdrBackendOptions>, "client" | "log">;
}

/**
 * try Herdr at startup and every 10 s while it is not running.
 *
 * The backend is registered with the registry **before** `connect()`: `connect()` emits
 * `session-added` and the initial `agent-state` for every pane it discovers, and those must reach
 * the `EventEngine`, which only subscribes through the registry. A registered-but-disconnected
 * member reports `isConnected: false`, so it is not advertised in `hello.backends` until it is real.
 * Herdr not being installed is a perfectly normal state, so failures log at debug, never as errors.
 */
export function startHerdrBackend(opts: StartHerdrOptions): { stop(): void } {
  const log = opts.log.child({ unit: "herdr-start" });
  const client = opts.client ?? new HerdrClient({ log: opts.log, socketPath: opts.socketPath });
  const backend = new HerdrBackend({ client, log: opts.log, ...opts.backendOptions });
  let timer: NodeJS.Timeout | null = null;
  let stopped = false;
  let announced = false;
  /** Fires `onUnavailable` at most once, after the FIRST failed attempt -- retries keep going
   * silently after that, so the CLI's banner line resolves without being repainted on every
   * 10 s retry. */
  let announcedUnavailable = false;

  opts.registry.add(backend);

  const schedule = (): void => {
    if (stopped || timer) return;
    timer = setTimeout(() => {
      timer = null;
      void attempt();
    }, opts.retryMs ?? 10_000);
    timer.unref?.();
  };

  const attempt = async (): Promise<void> => {
    if (stopped || backend.isConnected) return;
    try {
      await backend.connect();
    } catch (err) {
      // M-1: every other site in this branch logs the error NAME, never the message -- the
      // message reaching here is `BackendUnavailable`'s, which embeds the herdr error text and the
      // socket path (which contains the OS username). Only `ping` and `session.snapshot` can fail
      // here, but the branch should not carry the one exception to its own rule.
      log.debug("herdr not available", {
        error: safeErrorName(err),
      });
      if (opts.onUnavailable && !announcedUnavailable && err instanceof BackendUnavailable) {
        announcedUnavailable = true;
        opts.onUnavailable();
      }
      schedule();
      return;
    }
    // M-5: a separate try/catch so a throw from `onConnected` (the CLI's buffered `print` closure)
    // cannot become an unhandled rejection on the `void attempt()` call below -- and, since the
    // backend is already connected at this point, a failure here must not re-schedule a retry.
    try {
      if (stopped) return;
      log.info("herdr connected");
      if (opts.onConnected && !announced) {
        announced = true;
        const sessions = await backend.listSessions().catch(() => []);
        opts.onConnected(sessions.length);
      }
    } catch (err) {
      log.debug("herdr post-connect setup failed", {
        error: safeErrorName(err),
      });
    }
  };

  void attempt();

  return {
    stop(): void {
      stopped = true;
      if (timer) clearTimeout(timer);
      timer = null;
      void backend.close();
      // A long-lived host must not keep a dead member registered forever: unregistering also
      // drops it from `registry.capabilities`'s all-member AND, not just from `connected()`.
      opts.registry.remove("herdr");
    },
  };
}
