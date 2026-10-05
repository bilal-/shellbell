import { realpathSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { z } from "zod";
import { canonicalDestination, optionalStat } from "./host-files.js";
import type { LinuxMachineIdentity } from "./host-machine.js";

export interface SystemdUnitDefinition {
  v: 1;
  machineId: string;
  nodePath: string;
  cliPath: string;
  stateDir: string;
  runtimeRoot: string;
  serviceInstance: string;
  path: string;
}
export interface SystemdLocation {
  uid: number;
  home: string;
  configRoot: string;
  unitName: string;
  unitDir: string;
  definitionPath: string;
  enablementPath: string;
  managerRuntimeRoot: string;
}

const MAX_UNIT = 64 * 1024;
const MAX_METADATA = 16 * 1024;
const HEADER = "# shellbell-systemd-v1 ";
const safeText = z
  .string()
  .max(MAX_METADATA)
  .refine((value) => {
    for (const character of value) {
      const code = character.codePointAt(0)!;
      if (code < 32 || (code >= 127 && code <= 159) || (code >= 0xd800 && code <= 0xdfff))
        return false;
    }
    return true;
  });
const absolutePath = safeText.refine(isAbsolute);
const schema = z.strictObject({
  v: z.literal(1),
  machineId: z
    .string()
    .regex(/^[0-9a-f]{32}$/)
    .refine((value) => value !== "0".repeat(32)),
  // v249 load-fragment.c applies string_is_safe() to the unquoted executable.
  nodePath: absolutePath.refine((value) => !/["'\\]/.test(value)),
  cliPath: absolutePath,
  stateDir: absolutePath,
  runtimeRoot: absolutePath,
  serviceInstance: z.uuid(),
  path: safeText.refine((value) => {
    const entries = value.split(":");
    return entries.every(isAbsolute) && new Set(entries).size === entries.length;
  }),
});
function invalid(): never {
  throw new Error("shellbell: invalid or foreign systemd unit");
}

/** systemd.syntax quoting, including literal specifiers; this is not shell quoting. */
function quote(value: string): string {
  return `"${value.replaceAll("\\", "\\\\").replaceAll('"', '\\"').replaceAll("%", "%%")}"`;
}
function assignment(name: string, value: string): string {
  return `Environment=${quote(`${name}=${value}`)}`;
}

export function renderSystemdUnit(definition: SystemdUnitDefinition): Buffer {
  const parsed = schema.safeParse(definition);
  if (!parsed.success) invalid();
  const d = parsed.data;
  // Bound the canonical JSON before allocating it. Validated strings contain no
  // controls/surrogates, so only quotes and backslashes grow under JSON escaping.
  let metadataSize = 2;
  for (const [key, value] of Object.entries(d)) {
    metadataSize += key.length + 3 + (metadataSize === 2 ? 0 : 1);
    metadataSize +=
      typeof value === "number"
        ? 1
        : Buffer.byteLength(value) +
          2 +
          [...value].filter((character) => character === '"' || character === "\\").length;
  }
  if (metadataSize > MAX_METADATA) invalid();
  const metadata = JSON.stringify(d);
  if (Buffer.byteLength(metadata) > MAX_METADATA) invalid();
  const raw = Buffer.from(
    [
      HEADER + Buffer.from(metadata).toString("base64url"),
      "[Unit]",
      "Description=Shellbell terminal host",
      `ConditionHost=${d.machineId}`,
      "StartLimitIntervalSec=60s",
      "StartLimitBurst=3",
      "",
      "[Service]",
      "Type=exec",
      // ':' disables dollar-variable substitution for all arguments (systemd.service v249).
      `ExecStart=${[`:${d.nodePath}`, d.cliPath, "start", "--service"].map(quote).join(" ")}`,
      assignment("SHELLBELL_DIR", d.stateDir),
      assignment("SHELLBELL_SERVICE_INSTANCE", d.serviceInstance),
      assignment("XDG_RUNTIME_DIR", d.runtimeRoot),
      assignment("PATH", d.path),
      "Restart=on-failure",
      "RestartSec=5s",
      "TimeoutStopSec=15s",
      "UMask=0077",
      "StandardInput=null",
      "StandardOutput=null",
      "StandardError=journal",
      "KillMode=control-group",
      "",
      "[Install]",
      "WantedBy=default.target",
      "",
    ].join("\n"),
  );
  if (raw.length > MAX_UNIT) invalid();
  return raw;
}

export function parseSystemdUnit(raw: Uint8Array): SystemdUnitDefinition {
  try {
    if (raw.byteLength > MAX_UNIT) invalid();
    const bytes = Buffer.from(raw);
    const first = bytes.subarray(0, bytes.indexOf(10)).toString("utf8");
    if (!first.startsWith(HEADER)) invalid();
    const encoded = first.slice(HEADER.length);
    if (encoded.length > Math.ceil((MAX_METADATA * 4) / 3) || !/^[A-Za-z0-9_-]+$/.test(encoded))
      invalid();
    const metadata = Buffer.from(encoded, "base64url");
    if (metadata.length > MAX_METADATA || metadata.toString("base64url") !== encoded) invalid();
    const definition = schema.parse(JSON.parse(metadata.toString("utf8")));
    if (!renderSystemdUnit(definition).equals(bytes)) invalid();
    return definition;
  } catch {
    return invalid();
  }
}

function ownedDirectory(path: string, uid: number): void {
  const st = optionalStat(path);
  if (st && (!st.isDirectory() || st.isSymbolicLink() || st.uid !== uid || (st.mode & 0o022) !== 0))
    invalid();
}
function selectedRoot(path: string, uid: number): string {
  if (!absolutePath.safeParse(path).success) invalid();
  const canonical = optionalStat(path) ? realpathSync(path) : canonicalDestination(path);
  ownedDirectory(canonical, uid);
  return canonical;
}

/** Read-only selection; file publication belongs to the lifecycle transaction. */
export function selectSystemdLocation(input: {
  identity: LinuxMachineIdentity;
  env: NodeJS.ProcessEnv;
  home: string;
}): SystemdLocation {
  const { uid, hostScope } = input.identity;
  if (!Number.isSafeInteger(uid) || uid <= 0 || !/^[0-9a-f]{32}$/.test(hostScope)) invalid();
  const home = selectedRoot(input.home, uid);
  const configRoot = selectedRoot(
    input.env.XDG_CONFIG_HOME && isAbsolute(input.env.XDG_CONFIG_HOME)
      ? input.env.XDG_CONFIG_HOME
      : join(home, ".config"),
    uid,
  );
  const unitDir = join(configRoot, "systemd", "user");
  for (const dir of [join(configRoot, "systemd"), unitDir]) ownedDirectory(dir, uid);
  const unitName = `shellbell-${hostScope}.service`;
  const definitionPath = join(unitDir, unitName);
  const st = optionalStat(definitionPath);
  if (st && (!st.isFile() || st.isSymbolicLink() || st.uid !== uid || (st.mode & 0o7777) !== 0o600))
    invalid();
  return {
    uid,
    home,
    configRoot,
    unitName,
    unitDir,
    definitionPath,
    enablementPath: join(unitDir, "default.target.wants", unitName),
    managerRuntimeRoot: `/run/user/${uid}`,
  };
}
