import { parseArgs } from "node:util";
import { resolveConfig } from "./config.js";

type Command =
  | { command: "help" }
  | { command: "serve"; config: ReturnType<typeof resolveConfig> }
  | { command: "backup" | "restore"; source: string; destination: string };
export function parseCommand(args: string[], env: NodeJS.ProcessEnv): Command {
  const command = args[0]?.startsWith("-") || !args.length ? "serve" : args.shift();
  let values: Record<string, string | boolean | undefined>;
  try {
    ({ values } = parseArgs({
      args,
      options: {
        "data-dir": { type: "string" },
        host: { type: "string" },
        port: { type: "string" },
        "connection-queue-bytes": { type: "string" },
        "global-queue-bytes": { type: "string" },
        "shutdown-ms": { type: "string" },
        source: { type: "string" },
        destination: { type: "string" },
        help: { type: "boolean", short: "h" },
      },
    }));
  } catch {
    throw new Error("Invalid command arguments");
  }
  if (values.help) return { command: "help" as const };
  if (command === "backup" || command === "restore") {
    if (typeof values.source !== "string" || typeof values.destination !== "string")
      throw new Error("Source and new destination are required");
    return { command, source: values.source, destination: values.destination };
  }
  if (command !== "serve") throw new Error("Unknown command");
  function integer(key: string) {
    const value = values[key];
    if (value === undefined) return undefined;
    if (
      typeof value !== "string" ||
      !/^(0|[1-9][0-9]*)$/.test(value) ||
      !Number.isSafeInteger(Number(value))
    )
      throw new Error(`Invalid ${key}`);
    return Number(value);
  }
  return {
    command: "serve" as const,
    config: resolveConfig({
      dataDir: (values["data-dir"] as string | undefined) ?? env.SHELLBELL_RELAY_DATA_DIR ?? "",
      host: values.host as string | undefined,
      port: integer("port"),
      fcmServiceAccountFile: env.SHELLBELL_FCM_SERVICE_ACCOUNT_FILE,
      apnsPrivateKeyFile: env.SHELLBELL_APNS_PRIVATE_KEY_FILE,
      apnsTeamId: env.SHELLBELL_APNS_TEAM_ID,
      apnsKeyId: env.SHELLBELL_APNS_KEY_ID,
      apnsTopic: env.SHELLBELL_APNS_TOPIC,
      connectionQueueBytes: integer("connection-queue-bytes"),
      globalQueueBytes: integer("global-queue-bytes"),
      shutdownMs: integer("shutdown-ms"),
    }),
  };
}
