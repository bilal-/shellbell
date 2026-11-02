import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createLogger } from "../src/log.js";
import { installedVersion, ownPackageJson, watchInstalledVersion } from "../src/self-update.js";
import { switchBackground } from "../src/update-command.js";

afterEach(() => {
  vi.useRealTimers();
});

function packageDir(version: string | null, cli = true) {
  const root = mkdtempSync(join(tmpdir(), "sb-self-update-"));
  mkdirSync(join(root, "dist"));
  if (cli) writeFileSync(join(root, "dist", "cli.js"), "");
  const write = (v: string | null) =>
    writeFileSync(
      join(root, "package.json"),
      v === null ? '{"vers' : JSON.stringify({ version: v }),
    );
  write(version);
  return { packageJson: join(root, "package.json"), write };
}

function watch(packageJson: string, options: { busy?: () => boolean; graceMs?: number } = {}) {
  vi.useFakeTimers();
  const restart = vi.fn();
  const stop = watchInstalledVersion({
    running: "1.0.0",
    packageJson,
    busy: options.busy ?? (() => false),
    graceMs: options.graceMs,
    restart,
    log: createLogger({ stdout: false }),
    intervalMs: 1000,
    now: () => Date.now(),
  });
  return { restart, stop };
}

describe("installedVersion", () => {
  it("reads a version, and nothing from a partly written file", () => {
    expect(installedVersion(packageDir("2.0.0").packageJson)).toBe("2.0.0");
    expect(installedVersion(packageDir(null).packageJson)).toBeNull();
    expect(installedVersion("/nonexistent/package.json")).toBeNull();
  });
  it("finds package.json beside the dist folder", () => {
    expect(ownPackageJson("/opt/shellbell/dist/cli.js")).toBe("/opt/shellbell/package.json");
  });
});

describe("watchInstalledVersion", () => {
  it("never restarts while the same version is installed", () => {
    const { restart, stop } = watch(packageDir("1.0.0").packageJson);
    vi.advanceTimersByTime(10_000);
    expect(restart).not.toHaveBeenCalled();
    stop();
  });

  it("restarts once two checks see the same new version", () => {
    const pkg = packageDir("1.0.0");
    const { restart, stop } = watch(pkg.packageJson);
    pkg.write("2.0.0");
    vi.advanceTimersByTime(1000);
    expect(restart).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1000);
    expect(restart).toHaveBeenCalledExactlyOnceWith("2.0.0");
    vi.advanceTimersByTime(10_000);
    expect(restart).toHaveBeenCalledOnce();
    stop();
  });

  it("waits while an install is half written", () => {
    const pkg = packageDir("1.0.0");
    const { restart, stop } = watch(pkg.packageJson);
    pkg.write(null);
    vi.advanceTimersByTime(5000);
    expect(restart).not.toHaveBeenCalled();
    pkg.write("2.0.0");
    vi.advanceTimersByTime(2000);
    expect(restart).toHaveBeenCalledOnce();
    stop();
  });

  it("waits while the new version's CLI is missing", () => {
    const pkg = packageDir("1.0.0", false);
    const { restart, stop } = watch(pkg.packageJson);
    pkg.write("2.0.0");
    vi.advanceTimersByTime(5000);
    expect(restart).not.toHaveBeenCalled();
    stop();
  });

  it("starts over when the version changes again mid-install", () => {
    const pkg = packageDir("1.0.0");
    const { restart, stop } = watch(pkg.packageJson);
    pkg.write("2.0.0");
    vi.advanceTimersByTime(1000);
    pkg.write("2.0.1");
    vi.advanceTimersByTime(1000);
    expect(restart).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1000);
    expect(restart).toHaveBeenCalledExactlyOnceWith("2.0.1");
    stop();
  });

  it("waits for a phone looking at a session", () => {
    let busy = true;
    const pkg = packageDir("1.0.0");
    const { restart, stop } = watch(pkg.packageJson, {
      busy: () => busy,
      graceMs: 10_000,
    });
    pkg.write("2.0.0");
    vi.advanceTimersByTime(5000);
    expect(restart).not.toHaveBeenCalled();
    busy = false;
    vi.advanceTimersByTime(1000);
    expect(restart).toHaveBeenCalledOnce();
    stop();
  });

  it("restarts after the grace period even while a phone looks at a session", () => {
    const pkg = packageDir("1.0.0");
    const { restart, stop } = watch(pkg.packageJson, {
      busy: () => true,
      graceMs: 10_000,
    });
    pkg.write("2.0.0");
    vi.advanceTimersByTime(11_000);
    expect(restart).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1000);
    expect(restart).toHaveBeenCalledOnce();
    stop();
  });
});

it("never restarts for a package.json that already differed when Shellbell started", () => {
  const { restart, stop } = watch(packageDir("9.9.9").packageJson);
  vi.advanceTimersByTime(10_000);
  expect(restart).not.toHaveBeenCalled();
  stop();
});

describe("switchBackground", () => {
  it("runs the new version's install when Shellbell runs in the background", async () => {
    const run = vi.fn(async () => 0);
    const lines: string[] = [];
    expect(
      await switchBackground("/home/sam/.local/bin/shellbell", {
        status: async () => ({ installed: true }),
        run,
        log: (line) => lines.push(line),
      }),
    ).toBe(true);
    expect(run).toHaveBeenCalledExactlyOnceWith("/home/sam/.local/bin/shellbell", ["install"]);
    expect(lines.join(" ")).toMatch(/Switching the background Shellbell/);
  });

  it("says how to run it in the background when it isn't, without running anything", async () => {
    const run = vi.fn(async () => 0);
    const lines: string[] = [];
    expect(
      await switchBackground("/l", {
        status: async () => ({ installed: false }),
        run,
        log: (line) => lines.push(line),
      }),
    ).toBe(false);
    expect(run).not.toHaveBeenCalled();
    expect(lines.join(" ")).toMatch(/Run shellbell install/);
  });

  it("says to try again when the switch fails", async () => {
    const lines: string[] = [];
    await switchBackground("/l", {
      status: async () => ({ installed: true }),
      run: async () => 2,
      log: (line) => lines.push(line),
    });
    expect(lines.at(-1)).toMatch(/couldn't switch. Run shellbell install/);
  });
});
