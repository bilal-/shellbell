import { existsSync, readFileSync } from "node:fs";
import {
  fingerprint,
  generateIdentity,
  type Identity,
  identityFromJson,
  identityToJson,
} from "@shellbell/protocol";
import { ensureDir, type Paths, readJsonFile, writeSecretFile } from "./config.js";
import type { LinuxPaths } from "./host-paths.js";
import { readLinuxIdentity } from "./host-state.js";

/** Inspection never generates keys or includes identity contents in diagnostics. */
export function readIdentity(p: Paths): { identity: Identity; fp: string } | null {
  if (p.linuxHost) return readLinuxIdentity(p as LinuxPaths);
  let raw: string;
  try {
    raw = readFileSync(p.identity, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw new Error(`shellbell: cannot read identity at ${p.identity}`);
  }
  try {
    const identity = identityFromJson(JSON.parse(raw));
    return { identity, fp: fingerprint(identity.ed25519.pub) };
  } catch {
    throw new Error(`shellbell: invalid identity at ${p.identity}`);
  }
}

export function loadOrCreateIdentity(p: Paths): { identity: Identity; fp: string } {
  if (p.linuxHost) return readLinuxIdentity(p as LinuxPaths);
  ensureDir(p);
  let identity: Identity;
  if (existsSync(p.identity)) {
    try {
      identity = identityFromJson(readJsonFile(p.identity));
    } catch (err) {
      throw new Error(`shellbell: invalid identity at ${p.identity}: ${(err as Error).message}`);
    }
  } else {
    identity = generateIdentity();
    writeSecretFile(p.identity, `${JSON.stringify(identityToJson(identity), null, 2)}\n`);
  }
  return { identity, fp: fingerprint(identity.ed25519.pub) };
}
