// Disposable terminal-free subprocess: real FD 3 and real status socket.
import { createReadStream, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { join } from "node:path";

const dir = process.env.SHELLBELL_DIR!;
const settings = JSON.parse(readFileSync(join(dir, "desktop-fixture.json"), "utf8"));
if (settings.behavior === "early") process.exit(2);
const owner = createReadStream("", { fd: 3 });
let bytes = "";
let started = false;
const server = createServer((socket) => {
  socket.once("data", () => {
    const current = JSON.parse(readFileSync(join(dir, "desktop-fixture.json"), "utf8"));
    const data = {
      controlVersion: 1,
      process: {
        pid: process.pid,
        agentVersion: "1.0.0",
        computerFp: current.foreign ? "b".repeat(26) : settings.fp,
        stateDir: dir,
        serviceInstance: process.env.SHELLBELL_SERVICE_INSTANCE,
      },
      backends: ["iterm2", "tmux", "herdr"].map((name) => ({ name, connected: false })),
      terminalReady: false,
      relayOnline: false,
      sessions: 0,
      phones: [],
      connected: [],
    };
    socket.end(`${JSON.stringify({ ok: true, data })}\n`);
  });
});
function stop(reason: string) {
  if (settings.slowExit) {
    writeFileSync(join(dir, "desktop-exit.json"), "", { mode: 0o600 });
    settings.slowExit = false;
    setTimeout(() => stop(reason), 100);
    return;
  }
  writeFileSync(join(dir, "desktop-exit.json"), JSON.stringify({ pid: process.pid, reason }), {
    mode: 0o600,
  });
  server.close(() => process.exit(0));
  if (!started) process.exit(0);
}
owner.on("data", (chunk) => {
  bytes += chunk.toString();
  if (!bytes.endsWith("\n")) return;
  const value = JSON.parse(bytes);
  if (value.instance !== process.env.SHELLBELL_SERVICE_INSTANCE) process.exit(3);
  if (settings.behavior !== "unready") {
    started = true;
    server.listen(join(dir, "agent.sock"));
  }
});
owner.on("end", () => {
  if (settings.behavior !== "hung") stop("owner-eof");
});
process.once("SIGTERM", () => stop("sigterm"));
