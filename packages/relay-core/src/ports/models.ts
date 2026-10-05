import {
  Bytes,
  CtrlMessageSchema,
  FpSchema,
  fingerprint,
  ProtocolError,
} from "@shellbell/protocol";
import { MAX_PAIRING_ADMISSIONS } from "../limits.js";

export interface ComputerRecord {
  fingerprint: string;
  publicKey: Uint8Array;
  name: string | null;
  firstSeen: number;
  lastSeen: number;
}

export interface PairingRecord {
  phoneFp: string;
  publicKey: Uint8Array;
  /** Absent for legacy agent records; required before accepting proof-only v2 unpair. */
  pairId?: Uint8Array;
  name: string;
  pushToken: string | null;
  pushPlatform: string | null;
  pushProvider?: "fcm" | "apns";
  pushEnvironment?: "development" | "production";
  pushEnabled: boolean;
  pairedAt: number;
  lastSeenAt: number | null;
}

export interface PairingWindow {
  gateHash: Uint8Array;
  expiresAt: number;
  admitted: number;
}

function invalid(): never {
  throw new ProtocolError("malformed", "invalid identity record");
}

function record(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) invalid();
  return value as Record<string, unknown>;
}

export function identityTimestamp(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) invalid();
  return value;
}

function name(value: unknown, nullable = false): string | null {
  if (nullable && value === null) return null;
  if (typeof value !== "string" || value.length < 1 || value.length > 64) invalid();
  return value;
}

function identity(fp: unknown, pub: unknown): { fp: string; publicKey: Uint8Array } {
  const parsedFp = FpSchema.parse(fp);
  const publicKey = new Uint8Array(Bytes(32).parse(pub));
  if (fingerprint(publicKey) !== parsedFp) invalid();
  return { fp: parsedFp, publicKey };
}

/** Validate domain records at persistence boundaries and take ownership of their byte arrays. */
export function decodeComputerRecord(value: unknown): ComputerRecord {
  const row = record(value);
  const key = identity(row.fingerprint, row.publicKey);
  return {
    fingerprint: key.fp,
    publicKey: key.publicKey,
    name: name(row.name, true),
    firstSeen: identityTimestamp(row.firstSeen),
    lastSeen: identityTimestamp(row.lastSeen),
  };
}

export function decodePairingRecord(value: unknown): PairingRecord {
  const row = record(value);
  const key = identity(row.phoneFp, row.publicKey);
  if (
    row.pushToken !== null &&
    (typeof row.pushToken !== "string" ||
      row.pushToken.length < 1 ||
      row.pushToken.length > (row.pushProvider ? 4096 : 256))
  )
    invalid();
  if (row.pushPlatform !== null && row.pushPlatform !== "ios" && row.pushPlatform !== "android")
    invalid();
  if (typeof row.pushEnabled !== "boolean") invalid();
  if (row.pushProvider !== undefined || row.pushEnvironment !== undefined) {
    if (
      !CtrlMessageSchema.safeParse({
        type: "push-token",
        token: row.pushToken,
        platform: row.pushPlatform,
        enabled: row.pushEnabled,
        provider: row.pushProvider,
        environment: row.pushEnvironment,
      }).success
    )
      invalid();
  }
  return {
    phoneFp: key.fp,
    publicKey: key.publicKey,
    ...(row.pairId !== undefined &&
      row.pairId !== null && {
        pairId: new Uint8Array(Bytes(32).parse(row.pairId)),
      }),
    name: name(row.name) as string,
    pushToken: row.pushToken,
    pushPlatform: row.pushPlatform,
    ...(row.pushProvider ? { pushProvider: row.pushProvider as "fcm" | "apns" } : {}),
    ...(row.pushEnvironment
      ? { pushEnvironment: row.pushEnvironment as "development" | "production" }
      : {}),
    pushEnabled: row.pushEnabled,
    pairedAt: identityTimestamp(row.pairedAt),
    lastSeenAt: row.lastSeenAt === null ? null : identityTimestamp(row.lastSeenAt),
  };
}

export function decodePairingWindow(value: unknown): PairingWindow {
  const row = record(value);
  const admitted = identityTimestamp(row.admitted);
  if (admitted > MAX_PAIRING_ADMISSIONS) invalid();
  return {
    gateHash: new Uint8Array(Bytes(32).parse(row.gateHash)),
    expiresAt: identityTimestamp(row.expiresAt),
    admitted,
  };
}
