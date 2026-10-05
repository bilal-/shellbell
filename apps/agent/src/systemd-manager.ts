import { spawn } from "node:child_process";
import { accessSync, constants, statfsSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { privateDirectory } from "./host-files.js";
import type { SystemdLocation } from "./systemd-unit.js";

export interface SystemdObservation {
  available: boolean;
  loadState: string;
  activeState: string;
  subState: string;
  mainPid: number | null;
  unitFileState: string;
  fragmentPath: string;
  dropInPaths: string;
  needDaemonReload: boolean;
  conditionResult: boolean;
  diagnostic?: string;
}
export type SystemdVerb = "start" | "stop" | "daemon-reload";
export interface SystemdManagerApi {
  observe(): Promise<SystemdObservation>;
  execute(verb: SystemdVerb): Promise<void>;
  linger(): Promise<"yes" | "no" | "unknown">;
}
export interface SystemdCommandOptions {
  env: NodeJS.ProcessEnv;
  timeoutMs: number;
  maxOutputBytes: number;
}
export type SystemdCommand = (
  executable: string,
  args: readonly string[],
  options: SystemdCommandOptions,
) => Promise<{ exitCode: number; stdout: Buffer }>;

const properties = [
  "LoadState",
  "ActiveState",
  "SubState",
  "MainPID",
  "UnitFileState",
  "FragmentPath",
  "DropInPaths",
  "NeedDaemonReload",
  "ConditionResult",
];
const flags = ["--user", "--no-pager", "--no-ask-password"];
const localFilesystems = new Set([0x01021994, 0xef53, 0x58465342, 0x9123683e]);
const failure = () => new Error("shellbell: systemd command failed");
function safeText(value: string): boolean {
  for (const character of value) {
    const code = character.codePointAt(0)!;
    if (code < 32 || (code >= 127 && code <= 159) || (code >= 0xd800 && code <= 0xdfff))
      return false;
  }
  return true;
}
const unavailable = (): SystemdObservation => ({
  available: false,
  loadState: "unknown",
  activeState: "unknown",
  subState: "unknown",
  mainPid: null,
  unitFileState: "unknown",
  fragmentPath: "",
  dropInPaths: "",
  needDaemonReload: true,
  conditionResult: false,
  diagnostic: "systemd user manager unavailable or returned unsupported state",
});

/** Only standard absolute system locations, never PATH or caller-selected executables. */
function executable(name: "systemctl" | "loginctl"): string {
  for (const dir of ["/usr/bin", "/bin"]) {
    const path = join(dir, name);
    try {
      accessSync(path, constants.X_OK);
      return path;
    } catch {
      /* Try the other supported system location. */
    }
  }
  throw failure();
}

const runCommand: SystemdCommand = (binary, args, options) =>
  new Promise((resolve, reject) => {
    const child = spawn(binary, [...args], {
      shell: false,
      env: options.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let total = 0;
    const chunks: Buffer[] = [];
    let settled = false;
    let terminating = false;
    let escalation: ReturnType<typeof setTimeout> | undefined;
    const deadline = setTimeout(terminate, options.timeoutMs);
    function finish(code?: number | null): void {
      if (settled) return;
      settled = true;
      clearTimeout(deadline);
      clearTimeout(escalation);
      child.stdout.destroy();
      child.stderr.destroy();
      if (terminating || code === undefined || code === null) reject(failure());
      else resolve({ exitCode: code, stdout: Buffer.concat(chunks) });
    }
    function terminate(): void {
      if (settled || terminating) return;
      terminating = true;
      child.kill("SIGTERM");
      escalation = setTimeout(() => {
        child.kill("SIGKILL");
        finish();
      }, 250);
    }
    function output(chunk: Buffer, keep: boolean): void {
      if (settled || terminating) return;
      total += chunk.length;
      if (total > options.maxOutputBytes) {
        terminate();
        return;
      }
      if (keep) chunks.push(Buffer.from(chunk));
    }
    child.stdout.on("data", (chunk: Buffer) => output(chunk, true));
    child.stderr.on("data", (chunk: Buffer) => output(chunk, false));
    child.on("error", () => finish());
    child.on("close", (code) => finish(code));
  });

function parseObservation(stdout: Buffer): SystemdObservation {
  if (stdout.length > 65536) throw failure();
  const text = new TextDecoder("utf-8", { fatal: true }).decode(stdout);
  const lines = text.endsWith("\n") ? text.slice(0, -1).split("\n") : text.split("\n");
  const data = new Map<string, string>();
  for (const line of lines) {
    const separator = line.indexOf("=");
    const key = line.slice(0, separator);
    const value = line.slice(separator + 1);
    if (separator < 0 || !properties.includes(key) || data.has(key) || !safeText(value))
      throw failure();
    data.set(key, value);
  }
  if (data.size !== properties.length) throw failure();
  const get = (key: string) => data.get(key)!;
  const states: Record<string, readonly string[]> = {
    LoadState: ["stub", "loaded", "not-found", "bad-setting", "error", "merged", "masked"],
    ActiveState: [
      "active",
      "reloading",
      "inactive",
      "failed",
      "activating",
      "deactivating",
      "maintenance",
    ],
    SubState: [
      "dead",
      "condition",
      "start-pre",
      "start",
      "start-post",
      "running",
      "exited",
      "reload",
      "stop",
      "stop-watchdog",
      "stop-sigterm",
      "stop-sigkill",
      "stop-post",
      "final-sigterm",
      "final-sigkill",
      "failed",
      "auto-restart",
      "cleaning",
    ],
    UnitFileState: [
      "",
      "enabled",
      "enabled-runtime",
      "linked",
      "linked-runtime",
      "alias",
      "masked",
      "masked-runtime",
      "static",
      "disabled",
      "indirect",
      "generated",
      "transient",
      "bad",
    ],
  };
  for (const [key, values] of Object.entries(states))
    if (!values.includes(get(key))) throw failure();
  if (!/^(0|[1-9][0-9]*)$/.test(get("MainPID"))) throw failure();
  const pid = Number(get("MainPID"));
  if (!Number.isSafeInteger(pid)) throw failure();
  for (const key of ["NeedDaemonReload", "ConditionResult"])
    if (!["yes", "no"].includes(get(key))) throw failure();
  const fragmentPath = get("FragmentPath");
  if (fragmentPath && !isAbsolute(fragmentPath)) throw failure();
  return {
    available: true,
    loadState: get("LoadState"),
    activeState: get("ActiveState"),
    subState: get("SubState"),
    mainPid: pid || null,
    unitFileState: get("UnitFileState"),
    fragmentPath,
    dropInPaths: get("DropInPaths"),
    needDaemonReload: get("NeedDaemonReload") === "yes",
    conditionResult: get("ConditionResult") === "yes",
  };
}

function busAddress(path: string): string {
  // D-Bus address escaping is byte based; commas and semicolons must not add transports.
  return `unix:path=${[...Buffer.from(path)].map((byte) => (/[A-Za-z0-9_./-]/.test(String.fromCharCode(byte)) ? String.fromCharCode(byte) : `%${byte.toString(16).padStart(2, "0")}`)).join("")}`;
}

export function createSystemdManager(options: {
  location: SystemdLocation;
  run?: SystemdCommand;
  runtimeFsType?: (path: string) => number | bigint;
}): SystemdManagerApi {
  // Capture a snapshot so later caller mutations cannot change the scoped target.
  const location = { ...options.location };
  const run = options.run ?? runCommand;
  async function command(name: "systemctl" | "loginctl", args: readonly string[]): Promise<Buffer> {
    try {
      const { uid } = location;
      if (
        !Number.isSafeInteger(uid) ||
        uid <= 0 ||
        uid !== process.getuid?.() ||
        uid !== process.geteuid?.() ||
        !/^shellbell-[0-9a-f]{32}\.service$/.test(location.unitName)
      )
        throw failure();
      for (const path of [location.home, location.configRoot, location.managerRuntimeRoot])
        if (!isAbsolute(path) || !safeText(path)) throw failure();
      privateDirectory(location.managerRuntimeRoot, uid);
      const type =
        options.runtimeFsType?.(location.managerRuntimeRoot) ??
        statfsSync(location.managerRuntimeRoot).type;
      if (!localFilesystems.has(Number(type))) throw failure();
      const result = await run(options.run ? `/usr/bin/${name}` : executable(name), args, {
        timeoutMs: 30000,
        maxOutputBytes: 65536,
        env: {
          HOME: location.home,
          XDG_CONFIG_HOME: location.configRoot,
          XDG_RUNTIME_DIR: location.managerRuntimeRoot,
          DBUS_SESSION_BUS_ADDRESS: busAddress(join(location.managerRuntimeRoot, "bus")),
          PATH: "/usr/bin:/bin",
          LANG: "C",
          LC_ALL: "C",
        },
      });
      if (result.exitCode !== 0 || result.stdout.length > 65536) throw failure();
      return result.stdout;
    } catch {
      throw failure();
    }
  }
  return {
    async observe() {
      try {
        return parseObservation(
          await command("systemctl", [
            ...flags,
            "show",
            `--property=${properties.join(",")}`,
            location.unitName,
          ]),
        );
      } catch {
        return unavailable();
      }
    },
    async execute(verb) {
      if (!["start", "stop", "daemon-reload"].includes(verb)) throw failure();
      await command("systemctl", [
        ...flags,
        verb,
        ...(verb === "daemon-reload" ? [] : [location.unitName]),
      ]);
    },
    async linger() {
      try {
        const value = (
          await command("loginctl", [
            "--no-pager",
            "--no-ask-password",
            "show-user",
            String(location.uid),
            "--property=Linger",
            "--value",
          ])
        ).toString("utf8");
        if (value === "yes\n" || value === "yes") return "yes";
        if (value === "no\n" || value === "no") return "no";
      } catch {
        /* Unknown policy is not a reason to enable linger. */
      }
      return "unknown";
    },
  };
}
