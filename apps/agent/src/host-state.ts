import { readdirSync } from "node:fs";
import { join } from "node:path";
import {
  fingerprint,
  fromBase64Url,
  type Identity,
  identityFromJson,
  identityFromSeeds,
} from "@shellbell/protocol";
import { z } from "zod";
import {
  boundedRead,
  HostFileError,
  optionalStat,
  privateDirectory,
  sameFile,
} from "./host-files.js";
import type { LinuxPaths } from "./host-paths.js";
import { type AgentConfig, AgentConfigSchema, type Pairing, PairingsFile } from "./state-schema.js";

export const HostMarkerSchema = z
  .object({
    v: z.literal(1),
    hostDigest: z.string().regex(/^[0-9a-f]{64}$/),
    installationId: z.string().uuid(),
  })
  .strict();
export type HostStateStatus = "absent" | "ready" | "unmarked" | "wrong-host" | "invalid" | "unsafe";
export type HostStateInspection = { status: HostStateStatus; reason?: string };
export function validatedIdentity(bytes: Buffer): { identity: Identity; fp: string } {
  try {
    const identity = identityFromJson(JSON.parse(bytes.toString("utf8")));
    const derived = identityFromSeeds(
      identity.ed25519.priv,
      identity.x25519.priv,
      identity.createdAt,
    );
    if (
      !Buffer.from(derived.ed25519.pub).equals(Buffer.from(identity.ed25519.pub)) ||
      !Buffer.from(derived.x25519.pub).equals(Buffer.from(identity.x25519.pub))
    )
      throw new Error();
    return { identity, fp: fingerprint(identity.ed25519.pub) };
  } catch {
    throw new HostFileError("invalid");
  }
}
export function validatedConfig(bytes: Buffer): AgentConfig {
  try {
    return AgentConfigSchema.parse(JSON.parse(bytes.toString("utf8")));
  } catch {
    throw new HostFileError("invalid");
  }
}
export function validatedPairings(bytes: Buffer): Pairing[] {
  try {
    const { phones } = PairingsFile.parse(JSON.parse(bytes.toString("utf8")));
    for (const phone of phones) {
      const ed = fromBase64Url(phone.ed25519Pub);
      if (
        ed.length !== 32 ||
        fromBase64Url(phone.x25519Pub).length !== 32 ||
        fromBase64Url(phone.kPair).length !== 32 ||
        fingerprint(ed) !== phone.phoneFp
      )
        throw new Error();
    }
    return phones;
  } catch {
    throw new HostFileError("invalid");
  }
}
/** Shared by admission and adoption; returns only bounded, fully validated bytes. */
export function readCredentialBytes(
  dir: string,
  uid: number,
): { identity: Buffer; config: Buffer; pairings: Buffer } {
  const before = privateDirectory(dir, uid);
  const identity = boundedRead(join(dir, "identity.json"), 64 * 1024, uid);
  const config = boundedRead(join(dir, "config.json"), 64 * 1024, uid);
  const pairings = boundedRead(join(dir, "pairings.json"), 1024 * 1024, uid);
  validatedIdentity(identity);
  validatedConfig(config);
  validatedPairings(pairings);
  if (!sameFile(before, privateDirectory(dir, uid))) throw new HostFileError("unsafe");
  return { identity, config, pairings };
}
function admitLinuxState(
  p: LinuxPaths,
): HostStateInspection | { status: "ready"; bytes: ReturnType<typeof readCredentialBytes> } {
  try {
    if (!optionalStat(p.dir)) return { status: "absent" };
    const before = privateDirectory(p.dir, p.linuxHost.uid);
    // Unlike an adoption source, an active destination may be used for logging.
    // Validate every direct child, but never parse unknown private regular files.
    for (const name of readdirSync(p.dir)) {
      if (name === "service-owner.json.lock") {
        // The shared ownership store holds this private directory while a
        // lifecycle command re-admits credentials. No arbitrary directories
        // or contents are admitted alongside the host's private state.
        const guard = join(p.dir, name);
        const beforeGuard = privateDirectory(guard, p.linuxHost.uid);
        const entries = readdirSync(guard);
        const marker = entries[0];
        if (
          entries.length !== 1 ||
          !marker ||
          !/^owner-[1-9][0-9]*-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(
            marker,
          )
        )
          throw new HostFileError("unsafe");
        boundedRead(join(guard, marker), 0, p.linuxHost.uid);
        if (!sameFile(beforeGuard, privateDirectory(guard, p.linuxHost.uid)))
          throw new HostFileError("unsafe");
        continue;
      }
      const entry = optionalStat(join(p.dir, name));
      if (
        !entry?.isFile() ||
        entry.isSymbolicLink() ||
        entry.uid !== p.linuxHost.uid ||
        (entry.mode & 0o7777) !== 0o600
      )
        throw new HostFileError("unsafe");
    }
    const marker = join(p.dir, "host.json");
    if (!optionalStat(marker))
      return {
        status: "unmarked",
        reason: "Host marker missing; explicit host initialization or recovery required",
      };
    let parsed: z.infer<typeof HostMarkerSchema>;
    const bytes = boundedRead(marker, 4096, p.linuxHost.uid);
    try {
      parsed = HostMarkerSchema.parse(JSON.parse(bytes.toString("utf8")));
    } catch {
      throw new HostFileError("invalid");
    }
    if (parsed.hostDigest !== p.linuxHost.hostDigest)
      return {
        status: "wrong-host",
        reason: "State belongs to a different host; choose this host's state directory",
      };
    const credentials = readCredentialBytes(p.dir, p.linuxHost.uid);
    if (
      !bytes.equals(boundedRead(marker, 4096, p.linuxHost.uid)) ||
      !sameFile(before, privateDirectory(p.dir, p.linuxHost.uid))
    )
      throw new HostFileError("unsafe");
    return { status: "ready", bytes: credentials };
  } catch (error) {
    const status = error instanceof HostFileError && error.kind === "unsafe" ? "unsafe" : "invalid";
    return { status, reason: "Host state failed validation; inspect files and recover explicitly" };
  }
}
export function inspectLinuxState(p: LinuxPaths): HostStateInspection {
  const result = admitLinuxState(p);
  // Credential bytes never escape through the public inspection result.
  return result.status === "ready" ? { status: "ready" } : result;
}
function notReady(): Error {
  return new Error(
    "shellbell: Linux host state is not ready; use shellbell host init --new or host init --adopt <absolute-source> --confirm-source-inactive for absent state; inspect existing state before recovery",
  );
}
function admittedBytes(p: LinuxPaths): ReturnType<typeof readCredentialBytes> {
  const result = admitLinuxState(p);
  if (!("bytes" in result)) throw notReady();
  return result.bytes;
}
export function requireLinuxState(p: LinuxPaths): void {
  if (inspectLinuxState(p).status !== "ready") throw notReady();
}
export function readLinuxIdentity(p: LinuxPaths): { identity: Identity; fp: string } {
  return validatedIdentity(admittedBytes(p).identity);
}
export function readLinuxConfig(p: LinuxPaths): AgentConfig {
  return validatedConfig(admittedBytes(p).config);
}
export function readLinuxPairings(p: LinuxPaths): Pairing[] {
  return validatedPairings(admittedBytes(p).pairings);
}
