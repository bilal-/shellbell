import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach } from "vitest";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
export function fixture() {
  // Short paths also exercise Linux's actual sockaddr_un budget on macOS.
  const root = mkdtempSync("/tmp/sbh-");
  roots.push(root);
  const runtime = join(root, "r");
  mkdirSync(runtime, { mode: 0o700 });
  chmodSync(runtime, 0o700);
  const machineIdPath = join(root, "machine-id");
  writeFileSync(machineIdPath, "0123456789abcdef0123456789abcdef\n");
  const uid = process.getuid!();
  const options = {
    env: { XDG_RUNTIME_DIR: runtime },
    home: join(root, "home"),
    uid,
    euid: uid,
    machineIdPath,
    runtimeFsType: () => 0x01021994,
  };
  return { root, runtime, options };
}
export const config = {
  v: 1 as const,
  relayUrl: "wss://example.invalid",
  computerName: "Fixture",
  accent: "blue",
  notifyMinCommandMs: 10000,
  idleQuietMs: 4000,
  idleMinActiveMs: 1500,
};

export function api(name: "host-paths"): Promise<typeof import("../src/host-paths.js")>;
export function api(name: "host-state"): Promise<typeof import("../src/host-state.js")>;
export function api(name: "host-init"): Promise<typeof import("../src/host-init.js")>;
export async function api(name: string): Promise<unknown> {
  if (name === "host-paths") return import("../src/host-paths.js");
  if (name === "host-state") return import("../src/host-state.js");
  return import("../src/host-init.js");
}
