import { constants } from "node:fs";
import { open } from "node:fs/promises";
import {
  type DirectPushCredentials,
  type PushConfigurationReporter,
  parseDirectPushCredentials,
} from "@shellbell/relay-core";

export interface RelayNodeConfig {
  dataDir: string;
  host?: string;
  port?: number;
  fcmServiceAccountFile?: string;
  apnsPrivateKeyFile?: string;
  apnsTeamId?: string;
  apnsKeyId?: string;
  apnsTopic?: string;
  connectionQueueBytes?: number;
  globalQueueBytes?: number;
  shutdownMs?: number;
}

/** Bounded private file reads. A broken push configuration never prevents serving terminals. */
export async function loadNodePushCredentials(
  config: RelayNodeConfig,
  report: PushConfigurationReporter = () => {},
): Promise<DirectPushCredentials> {
  const failed = new Set<"fcm" | "apns">();
  async function read(path: string | undefined, provider: "fcm" | "apns", maximum: number) {
    if (!path) return undefined;
    try {
      // Nonblocking open also covers a symlink or path swapped to a FIFO.
      // Validate the opened descriptor (not a preceding path stat) so regular
      // secret-file symlinks work without a check/open race.
      const file = await open(path, constants.O_RDONLY | constants.O_NONBLOCK);
      try {
        if (!(await file.stat()).isFile()) throw new Error();
        const buffer = Buffer.alloc(maximum + 1);
        let length = 0;
        while (length < buffer.length) {
          const { bytesRead } = await file.read(buffer, length, buffer.length - length, null);
          if (!bytesRead) break;
          length += bytesRead;
        }
        if (!length || length > maximum) throw new Error();
        return new TextDecoder("utf-8", { fatal: true }).decode(buffer.subarray(0, length));
      } finally {
        await file.close();
      }
    } catch {
      failed.add(provider);
      return undefined;
    }
  }
  const [fcmServiceAccountJson, apnsPrivateKey] = await Promise.all([
    read(config.fcmServiceAccountFile, "fcm", 65536),
    read(config.apnsPrivateKeyFile, "apns", 16384),
  ]);
  return parseDirectPushCredentials(
    {
      fcmServiceAccountJson,
      apnsPrivateKey,
      apnsTeamId: config.apnsTeamId,
      apnsKeyId: config.apnsKeyId,
      apnsTopic: config.apnsTopic,
    },
    (provider, code) => report(provider, failed.has(provider) ? "invalid-credentials" : code),
  );
}
export function resolveConfig(config: RelayNodeConfig) {
  if (!config.dataDir || config.dataDir === ":memory:")
    throw new Error("An explicit durable data directory is required");
  const result = {
    ...config,
    host: config.host ?? "127.0.0.1",
    port: config.port ?? 8787,
    connectionQueueBytes: config.connectionQueueBytes ?? 2 * 1024 * 1024,
    globalQueueBytes: config.globalQueueBytes ?? 64 * 1024 * 1024,
    shutdownMs: config.shutdownMs ?? 5000,
  };
  for (const key of ["port", "connectionQueueBytes", "globalQueueBytes", "shutdownMs"] as const)
    if (!Number.isSafeInteger(result[key]) || result[key] < 0) throw new Error(`Invalid ${key}`);
  if (
    result.port > 65535 ||
    !result.host ||
    result.connectionQueueBytes < 1 ||
    result.globalQueueBytes < 1
  )
    throw new Error("Invalid listener or queue configuration");
  return result;
}
