import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  type Stats,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir, userInfo } from "node:os";
import { dirname, isAbsolute, join } from "node:path";
import { writeSecretFile } from "./config.js";
import { assertNoLegacyRegistration } from "./legacy-installation.js";
import { runServiceCommand, type ServiceCommand } from "./service-command.js";
import { validateServiceText } from "./service-environment.js";
import type { ServiceDefinition, ServiceManager, ServiceSnapshot } from "./service-manager.js";

export type { ServiceCommand } from "./service-command.js";
export const LABEL = "sh.bilal.shellbell";
export const PLIST = join(homedir(), "Library", "LaunchAgents", `${LABEL}.plist`);

const MAX_DEFINITION_BYTES = 1024 * 1024;
const COMMAND_TIMEOUT_MS = 5000;
const COMMAND_OUTPUT_BYTES = 64 * 1024;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const ENVIRONMENT_KEYS = new Set([
  "SHELLBELL_DIR",
  "SHELLBELL_SERVICE_INSTANCE",
  "PATH",
  "HERDR_SOCKET_PATH",
  "XDG_CONFIG_HOME",
]);
const DEFINITION_KEYS = new Set([
  "Label",
  "ProgramArguments",
  "EnvironmentVariables",
  "RunAtLoad",
  "KeepAlive",
  "StandardOutPath",
  "StandardErrorPath",
]);

export interface LaunchdManagerOptions {
  run?: ServiceCommand;
  uid?: number;
  homeDir?: string;
  definitionPath?: string;
}

function xmlEscape(value: string): string {
  validateServiceText(value);
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

export function plistFor(o: {
  nodePath: string;
  cliPath: string;
  logPath: string;
  environment?: Record<string, string>;
}): string {
  const esc = xmlEscape;
  const environment = o.environment ?? { PATH: "/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin" };
  const environmentXml = Object.entries(environment)
    .map(([key, value]) => `<key>${esc(key)}</key><string>${esc(value)}</string>`)
    .join("");
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>${LABEL}</string>
  <key>ProgramArguments</key><array>
    <string>${esc(o.nodePath)}</string><string>${esc(o.cliPath)}</string><string>start</string><string>--service</string>
  </array>
  <key>EnvironmentVariables</key><dict>${environmentXml}</dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>${esc(o.logPath)}</string>
  <key>StandardErrorPath</key><string>${esc(o.logPath)}</string>
</dict></plist>
`;
}

function requireAbsolute(value: unknown, name: string): string {
  if (typeof value !== "string" || !value || !isAbsolute(value)) {
    throw new Error(`invalid service definition: ${name} must be an absolute path`);
  }
  xmlEscape(value);
  return value;
}

function parseDefinition(value: unknown, homeDir: string): ServiceDefinition {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("invalid service definition");
  const plist = value as Record<string, unknown>;
  for (const key of Object.keys(plist)) {
    if (!DEFINITION_KEYS.has(key)) throw new Error(`unrecognized service definition key: ${key}`);
  }
  if (
    plist.Label !== LABEL ||
    !Array.isArray(plist.ProgramArguments) ||
    plist.ProgramArguments.length !== 4 ||
    plist.ProgramArguments[2] !== "start" ||
    plist.ProgramArguments[3] !== "--service" ||
    plist.RunAtLoad !== true ||
    plist.KeepAlive !== true ||
    plist.StandardOutPath !== plist.StandardErrorPath
  ) {
    throw new Error("unrecognized Shellbell service definition");
  }
  const environment = plist.EnvironmentVariables;
  if (!environment || typeof environment !== "object" || Array.isArray(environment)) {
    throw new Error("invalid service environment");
  }
  const env = environment as Record<string, unknown>;
  for (const [key, entry] of Object.entries(env)) {
    if (!ENVIRONMENT_KEYS.has(key)) throw new Error(`unrecognized service environment: ${key}`);
    if (typeof entry !== "string") throw new Error(`invalid service environment: ${key}`);
    xmlEscape(key);
    xmlEscape(entry);
    if (key === "HERDR_SOCKET_PATH" || key === "XDG_CONFIG_HOME") requireAbsolute(entry, key);
  }
  if (
    typeof env.PATH !== "string" ||
    !env.PATH ||
    env.PATH.split(":").some((entry) => !entry || !isAbsolute(entry))
  ) {
    throw new Error("invalid service PATH");
  }
  const stateDir =
    env.SHELLBELL_DIR === undefined
      ? join(homeDir, ".shellbell")
      : requireAbsolute(env.SHELLBELL_DIR, "SHELLBELL_DIR");
  const marker = env.SHELLBELL_SERVICE_INSTANCE;
  if (marker !== undefined && (typeof marker !== "string" || !UUID.test(marker))) {
    throw new Error("invalid service instance");
  }
  return {
    nodePath: requireAbsolute(plist.ProgramArguments[0], "nodePath"),
    cliPath: requireAbsolute(plist.ProgramArguments[1], "cliPath"),
    stateDir,
    serviceInstance: (marker as string | undefined) ?? null,
    environment: env as Record<string, string>,
    logPath: requireAbsolute(plist.StandardOutPath, "logPath"),
  };
}

function validateNewDefinition(definition: ServiceDefinition): void {
  requireAbsolute(definition.nodePath, "nodePath");
  requireAbsolute(definition.cliPath, "cliPath");
  requireAbsolute(definition.stateDir, "stateDir");
  requireAbsolute(definition.logPath, "logPath");
  if (!definition.serviceInstance || !UUID.test(definition.serviceInstance)) {
    throw new Error("serviceInstance must be a UUID");
  }
  const env = definition.environment;
  if (
    env.SHELLBELL_DIR !== definition.stateDir ||
    env.SHELLBELL_SERVICE_INSTANCE !== definition.serviceInstance
  ) {
    throw new Error("service definition and environment disagree");
  }
  if (!env.PATH || env.PATH.split(":").some((entry) => !entry || !isAbsolute(entry))) {
    throw new Error("invalid service PATH");
  }
  for (const [key, value] of Object.entries(env)) {
    if (!ENVIRONMENT_KEYS.has(key)) throw new Error(`unsupported service environment: ${key}`);
    if (typeof value !== "string") throw new Error(`invalid service environment: ${key}`);
    xmlEscape(key);
    xmlEscape(value);
    if (key === "HERDR_SOCKET_PATH" || key === "XDG_CONFIG_HOME") requireAbsolute(value, key);
  }
}

export function createLaunchdManager(options: LaunchdManagerOptions = {}): ServiceManager {
  const run = options.run ?? runServiceCommand;
  const uid = options.uid ?? userInfo().uid;
  if (!Number.isSafeInteger(uid) || uid < 0) throw new Error("invalid service UID");
  const homeDir = options.homeDir ?? homedir();
  const definitionPath =
    options.definitionPath ?? join(homeDir, "Library", "LaunchAgents", `${LABEL}.plist`);
  const domain = `gui/${uid}`;
  const target = `${domain}/${LABEL}`;
  type Fingerprint = { stat: Stats; raw: Buffer };
  // undefined: not observed yet; null: validated absence.
  let expected: Fingerprint | null | undefined;

  function same(a: Fingerprint | null, b: Fingerprint | null): boolean {
    if (a === null || b === null) return a === b;
    return (
      a.stat.dev === b.stat.dev &&
      a.stat.ino === b.stat.ino &&
      a.stat.uid === b.stat.uid &&
      a.stat.mode === b.stat.mode &&
      a.stat.size === b.stat.size &&
      a.stat.mtimeMs === b.stat.mtimeMs &&
      a.stat.ctimeMs === b.stat.ctimeMs &&
      a.raw.equals(b.raw)
    );
  }

  function fingerprintAtPath(): Fingerprint | null {
    let stat: Stats;
    try {
      stat = lstatSync(definitionPath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }
    if (
      !stat.isFile() ||
      stat.isSymbolicLink() ||
      stat.uid !== uid ||
      (stat.mode & 0o022) !== 0 ||
      stat.size > MAX_DEFINITION_BYTES
    ) {
      return { stat, raw: Buffer.alloc(0) };
    }
    return { stat, raw: readFileSync(definitionPath) };
  }

  function assertPathStillMatches(reference: Fingerprint | null): void {
    if (!same(reference, fingerprintAtPath())) {
      throw new Error("service definition changed or was replaced during operation");
    }
  }

  function trackPublished(raw: Buffer): void {
    const published = fingerprintAtPath();
    if (!published?.raw.equals(raw)) {
      throw new Error("service definition changed after publication");
    }
    expected = published;
  }

  async function command(
    executable: string,
    args: string[],
    captureOutput = false,
    input?: Uint8Array,
  ) {
    const result = await run(executable, args, {
      input,
      timeoutMs: COMMAND_TIMEOUT_MS,
      maxOutputBytes:
        executable === "/usr/bin/plutil" ? MAX_DEFINITION_BYTES : COMMAND_OUTPUT_BYTES,
      captureOutput,
    });
    if (!Number.isInteger(result.exitCode))
      throw new Error(`${executable} returned invalid exit status`);
    return result;
  }

  async function decodeDefinition(raw: Buffer): Promise<ServiceDefinition> {
    const result = await command(
      "/usr/bin/plutil",
      ["-convert", "json", "-o", "-", "-"],
      true,
      raw,
    );
    if (result.exitCode !== 0) throw new Error("plutil could not parse service definition");
    let object: unknown;
    try {
      object = JSON.parse(result.stdout.toString("utf8"));
    } catch {
      throw new Error("plutil returned invalid service definition JSON");
    }
    return parseDefinition(object, homeDir);
  }

  async function readDefinition(): Promise<
    (Fingerprint & { definition: ServiceDefinition }) | null
  > {
    let stat: Stats;
    try {
      stat = lstatSync(definitionPath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }
    if (
      !stat.isFile() ||
      stat.isSymbolicLink() ||
      stat.uid !== uid ||
      (stat.mode & 0o022) !== 0 ||
      stat.size > MAX_DEFINITION_BYTES
    ) {
      throw new Error("unsafe service definition metadata");
    }
    const raw = readFileSync(definitionPath);
    if (raw.length > MAX_DEFINITION_BYTES) throw new Error("service definition too large");
    const definition = await decodeDefinition(raw);
    const fingerprint = { stat, raw };
    assertPathStillMatches(fingerprint);
    return { ...fingerprint, definition };
  }

  async function loaded(): Promise<boolean> {
    const result = await command("/bin/launchctl", ["print", target]);
    if (result.exitCode === 0) return true;
    if (result.exitCode === 113) return false;
    throw new Error(`launchctl print failed (${result.exitCode})`);
  }
  async function startupEnabled(): Promise<boolean | null> {
    try {
      const result = await command("/bin/launchctl", ["print-disabled", domain], true);
      const lines = new TextDecoder("utf-8", { fatal: true })
        .decode(result.stdout)
        .trim()
        .split(/\r?\n/)
        .map((line) => line.trim());
      if (result.exitCode !== 0 || lines.shift() !== "disabled services = {" || lines.pop() !== "}")
        return null;
      const own = lines.filter((line) => line.includes(`"${LABEL}"`));
      if (own.length === 0) return true;
      if (own.length !== 1) return null;
      if (own[0] === `"${LABEL}" => disabled` || own[0] === `"${LABEL}" => true`) return false;
      if (own[0] === `"${LABEL}" => enabled` || own[0] === `"${LABEL}" => false`) return true;
      return null;
    } catch {
      return null;
    }
  }

  const manager: ServiceManager = {
    kind: "launchd",
    definitionPath,
    async inspect(): Promise<ServiceSnapshot> {
      const installed = await readDefinition();
      const isLoaded = await loaded();
      assertPathStillMatches(installed);
      if (!installed && isLoaded)
        throw new Error("loaded Shellbell job has no valid installed definition");
      if (expected !== undefined && !same(expected, installed)) {
        throw new Error("service definition changed or was replaced after inspection");
      }
      if (expected === undefined) expected = installed;
      return {
        installed: !!installed,
        startupEnabled: installed ? await startupEnabled() : false,
        loaded: isLoaded,
        raw: installed?.raw ?? null,
        definition: installed?.definition ?? null,
      };
    },
    async setStartupEnabled(enabled) {
      const snapshot = await manager.inspect();
      if (!snapshot.installed) throw new Error("service is not installed");
      if (snapshot.startupEnabled === enabled) return;
      const result = await command("/bin/launchctl", [enabled ? "enable" : "disable", target]);
      if (result.exitCode !== 0) throw new Error("launchctl startup preference change failed");
      if ((await manager.inspect()).startupEnabled !== enabled)
        throw new Error("launchctl startup preference could not be verified");
    },
    async write(definition) {
      await assertNoLegacyRegistration(run, uid, homeDir);
      validateNewDefinition(definition);
      const prior = await readDefinition(); // never overwrite an unknown or unsafe definition
      if (expected !== undefined && !same(expected, prior)) {
        throw new Error("service definition changed or was replaced after inspection");
      }
      if (!prior && (await loaded()))
        throw new Error("loaded Shellbell job has no installed definition");
      const xml = plistFor({ ...definition });
      mkdirSync(dirname(definitionPath), { recursive: true, mode: 0o700 });
      writeSecretFile(definitionPath, xml, () => assertPathStillMatches(prior));
      trackPublished(Buffer.from(xml));
    },
    async restore(raw) {
      if (raw !== null && raw.length > MAX_DEFINITION_BYTES)
        throw new Error("service definition too large");
      const current = await readDefinition();
      if (expected !== undefined && !same(expected, current)) {
        throw new Error("service definition changed or was replaced after inspection");
      }
      if (raw === null) {
        if (!current) return;
        if (expected === undefined) {
          throw new Error("refusing to remove unexpected service definition replacement");
        }
        assertPathStillMatches(current);
        unlinkSync(definitionPath);
        expected = null;
        return;
      }
      if (!current) throw new Error("cannot restore absent service definition");
      if (expected === undefined) throw new Error("service definition changed unexpectedly");
      await decodeDefinition(raw);
      writeSecretFile(definitionPath, raw, () => assertPathStillMatches(current));
      trackPublished(raw);
    },
    async load() {
      await assertNoLegacyRegistration(run, uid, homeDir);
      const snapshot = await manager.inspect();
      if (!snapshot.installed) throw new Error("service definition is not installed");
      if (snapshot.startupEnabled === null)
        throw new Error("service startup preference is unresolved");
      const temporarilyEnabled = snapshot.startupEnabled === false;
      try {
        if (temporarilyEnabled) await manager.setStartupEnabled(true);
        if (!snapshot.loaded) {
          const result = await command("/bin/launchctl", ["bootstrap", domain, definitionPath]);
          if (result.exitCode !== 0)
            throw new Error(`launchctl bootstrap failed (${result.exitCode})`);
        }
        const result = await command("/bin/launchctl", ["kickstart", "-p", target], true);
        if (result.exitCode !== 0)
          throw new Error(`launchctl kickstart failed (${result.exitCode})`);
        const pidText = result.stdout.toString("utf8").trim();
        if (!/^[1-9][0-9]*$/.test(pidText)) throw new Error("invalid launchctl PID output");
        const pid = Number(pidText);
        if (!Number.isSafeInteger(pid) || pid > 2147483647)
          throw new Error("invalid launchctl PID output");
        return pid;
      } finally {
        if (temporarilyEnabled) await manager.setStartupEnabled(false);
      }
    },
    async unload() {
      const snapshot = await manager.inspect();
      if (!snapshot.loaded) return;
      const result = await command("/bin/launchctl", ["bootout", target]);
      if (result.exitCode !== 0) throw new Error(`launchctl bootout failed (${result.exitCode})`);
      if (await loaded()) throw new Error("launchctl bootout did not unload service");
    },
  };
  return manager;
}

/** Pre-creates (or fixes the mode of) the launchd log file as 0600, before `install()` runs
 * `launchctl bootstrap` -- otherwise launchd creates `StandardOutPath`/`StandardErrorPath` itself
 * under the default umask the first time the service writes to it (§8.2). Exported so this can be
 * tested without touching `launchctl`; never truncates an existing file's content. */
export function prepareLogFile(logPath: string): void {
  if (!existsSync(logPath)) writeFileSync(logPath, "", { mode: 0o600 });
  else chmodSync(logPath, 0o600);
}
