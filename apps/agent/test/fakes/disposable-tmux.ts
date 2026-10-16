import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { rmSync } from "node:fs";
import { promisify } from "node:util";

const run = promisify(execFile);

/** A uniquely named tmux socket that never reaches the owner's own tmux server. */
export function disposableTmuxSocket(): string {
  return `shellbell-test-${randomUUID()}`;
}

/** Stops the disposable server and removes the socket file tmux leaves behind. */
export async function removeDisposableTmux(socketName: string): Promise<void> {
  const { stdout } = await run("tmux", [
    "-L",
    socketName,
    "display-message",
    "-p",
    "#{socket_path}",
  ]).catch(() => ({ stdout: "" }));
  await run("tmux", ["-L", socketName, "kill-server"]).catch(() => {});
  const path = stdout.trim();
  if (path.endsWith(`/${socketName}`)) rmSync(path, { force: true });
}
