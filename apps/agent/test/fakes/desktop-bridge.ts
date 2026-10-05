import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { DesktopSupervisor } from "../../src/native/desktop-supervisor.js";

const dir = process.argv[2]!;
const selection = JSON.parse(readFileSync(join(dir, "desktop-selection.json"), "utf8"));
const supervisor = new DesktopSupervisor({
  uid: process.getuid!(),
  homeDir: dir,
  admitBundle: async () => ({
    executable: process.execPath,
    nodePath: process.execPath,
    controllerPath: fileURLToPath(import.meta.url),
    servicePath: fileURLToPath(new URL("./desktop-child.ts", import.meta.url)),
    agentVersion: "1.0.0",
  }),
});
const job = await supervisor.start(selection);
process.stdout.write(`${JSON.stringify(job)}\n`);
