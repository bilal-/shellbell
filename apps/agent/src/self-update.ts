import { closeSync, existsSync, openSync, readSync } from "node:fs";
import { dirname, join } from "node:path";
import type { Logger } from "./log.js";

/** Exit code that asks launchd (KeepAlive) and systemd (Restart=on-failure) to start us again. */
export const RESTART_FOR_UPDATE = 75;

/** The version in a package.json, or null while it is missing, partly written or unreadable. */
export function installedVersion(packageJson: string): string | null {
  let fd: number | undefined;
  try {
    fd = openSync(packageJson, "r");
    const buffer = Buffer.alloc(64 * 1024);
    const length = readSync(fd, buffer, 0, buffer.length, 0);
    const version = (
      JSON.parse(buffer.subarray(0, length).toString("utf8")) as { version?: unknown }
    ).version;
    return typeof version === "string" && /^\d+\.\d+\.\d+/.test(version) ? version : null;
  } catch {
    return null;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

/** package.json beside the dist/ folder this CLI runs from. */
export function ownPackageJson(cliPath: string = process.argv[1] ?? ""): string {
  return join(dirname(dirname(cliPath)), "package.json");
}

export interface SelfUpdateOptions {
  running: string;
  packageJson: string;
  /** True while a phone is looking at a session: restarting then would interrupt it. */
  busy: () => boolean;
  restart: (installed: string) => void;
  log: Logger;
  intervalMs?: number;
  /** How long a busy phone may hold off the restart, so mixed versions never last. */
  graceMs?: number;
  now?: () => number;
}

/**
 * Restarts the background Shellbell once a package manager, such as `npm install -g`, has
 * replaced the files it runs from. Until then the old process would keep the old version, and
 * would load later parts of the new one beside it. A new version counts once two checks agree
 * and its CLI is in place, so a half-written install is never started.
 */
export function watchInstalledVersion(options: SelfUpdateOptions): () => void {
  const now = options.now ?? Date.now;
  // Only a change while we run counts: a package.json that never matched the running build
  // must not restart Shellbell over and over.
  const baseline = installedVersion(options.packageJson) ?? options.running;
  let candidate: string | null = null;
  let confirmedAt: number | null = null;
  let done = false;
  const check = () => {
    if (done) return;
    const version = installedVersion(options.packageJson);
    const cli = join(dirname(options.packageJson), "dist", "cli.js");
    if (!version || version === baseline || !existsSync(cli)) {
      candidate = null;
      confirmedAt = null;
      return;
    }
    if (version !== candidate) {
      candidate = version;
      confirmedAt = null;
      return;
    }
    confirmedAt ??= now();
    const waited = now() - confirmedAt;
    if (options.busy() && waited < (options.graceMs ?? 10 * 60_000)) return;
    done = true;
    options.log.info("installed version changed; restarting", {
      from: options.running,
      to: version,
    });
    options.restart(version);
  };
  const timer = setInterval(check, options.intervalMs ?? 60_000);
  timer.unref?.();
  return () => {
    done = true;
    clearInterval(timer);
  };
}
