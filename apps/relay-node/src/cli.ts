#!/usr/bin/env node
import { backupRelay, restoreRelay } from "./backup.js";
import { parseCommand } from "./command.js";
import { startRelay } from "./server.js";

async function main() {
  const command = parseCommand(process.argv.slice(2), process.env);
  if (command.command === "help") {
    console.log(
      "Usage: shellbell-relay serve --data-dir /absolute/private/directory [--host 127.0.0.1] [--port 8787]\nshellbell-relay backup --source /data --destination /archives/new.sqlite\nshellbell-relay restore --source /archives/backup.sqlite --destination /new-data\nOptions: --connection-queue-bytes, --global-queue-bytes, --shutdown-ms\nOptional push: SHELLBELL_FCM_SERVICE_ACCOUNT_FILE, SHELLBELL_APNS_PRIVATE_KEY_FILE, SHELLBELL_APNS_TEAM_ID, SHELLBELL_APNS_KEY_ID, SHELLBELL_APNS_TOPIC. Use private credential files for your signed app. Backup requires a stopped service; restore requires a new directory.",
    );
    return;
  }
  if (command.command === "backup" || command.command === "restore") {
    await (command.command === "backup" ? backupRelay : restoreRelay)(
      command.source,
      command.destination,
    );
    console.log(JSON.stringify({ event: `${command.command}-complete` }));
    return;
  }
  if (command.command !== "serve") throw new Error("Unknown command");
  const relay = await startRelay(command.config);
  console.log(JSON.stringify({ event: "ready", url: relay.url }));
  const stop = () => {
    void relay.close().then(
      () => process.exit(0),
      () => {
        console.error("Relay shutdown failed");
        process.exit(1);
      },
    );
  };
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
}
main().catch(() => {
  console.error(
    "Relay operation failed; check configuration, storage permissions, exclusive ownership, and new destination",
  );
  process.exitCode = 1;
});
