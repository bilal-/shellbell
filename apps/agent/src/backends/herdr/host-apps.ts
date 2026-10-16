import { basename } from "node:path";
import { hostAppOf, type ProcessEntry, readProcessTable } from "../host-app.js";
import { herdrSocketPath } from "./client.js";

const MAX_APPS = 4;

/**
 * The session an interactive Herdr client attaches to: `""` for `herdr` alone, the name for
 * `herdr --session <name>` or `herdr session attach <name>`, and undefined for every other
 * command, including `herdr server` and the API helpers.
 */
export function herdrClientSession(args: string): string | undefined {
  const [program, ...rest] = args.trim().split(/\s+/);
  if (!program || basename(program) !== "herdr") return undefined;
  if (rest.length === 0) return "";
  if (rest[0] === "--session" && rest.length === 2) return rest[1];
  if (rest.length === 1 && rest[0]!.startsWith("--session=")) return rest[0]!.slice(10);
  if (rest[0] === "session" && rest[1] === "attach" && rest.length === 3) return rest[2];
  return undefined;
}

/**
 * Desktop apps running a client of the Herdr server at `socketPath`. Herdr's API does not list
 * its clients, so this matches client command lines to the socket they would open by default.
 */
export function herdrHostApps(
  table: ReadonlyMap<number, ProcessEntry>,
  socketPath: string,
  env: NodeJS.ProcessEnv = process.env,
): string[] {
  const apps = new Set<string>();
  for (const [pid, entry] of table) {
    const session = herdrClientSession(entry.args);
    if (session === undefined) continue;
    const path = herdrSocketPath({
      XDG_CONFIG_HOME: env.XDG_CONFIG_HOME,
      ...(session ? { HERDR_SESSION: session } : {}),
    });
    if (path !== socketPath) continue;
    const app = hostAppOf(pid, table);
    if (app) apps.add(app);
  }
  return [...apps].sort((a, b) => a.localeCompare(b)).slice(0, MAX_APPS);
}

export async function readHerdrHostApps(socketPath: string): Promise<string[] | undefined> {
  const table = await readProcessTable();
  return table && herdrHostApps(table, socketPath);
}
