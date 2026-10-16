import { execFile } from "node:child_process";
import { promisify } from "node:util";

const run = promisify(execFile);
const MAX_DEPTH = 32;
/** Bundle names whose product name differs from the `.app` folder. */
const APP_NAMES: Readonly<Record<string, string>> = { iTerm: "iTerm2" };
const BUNDLE = /\/([^/]+)\.app\/Contents\/MacOS\//;

export interface ProcessEntry {
  ppid: number;
  args: string;
}

/** `ps -axww -o pid=,ppid=,args=` output, keyed by pid. */
export function parseProcessTable(text: string): Map<number, ProcessEntry> {
  const table = new Map<number, ProcessEntry>();
  for (const line of text.split("\n")) {
    const match = /^\s*(\d+)\s+(\d+)\s+(.*)$/.exec(line);
    if (match) table.set(Number(match[1]), { ppid: Number(match[2]), args: match[3]! });
  }
  return table;
}

/** Display-only and best-effort: macOS app bundles only, and no table when `ps` fails. */
export async function readProcessTable(): Promise<Map<number, ProcessEntry> | undefined> {
  if (process.platform !== "darwin") return undefined;
  try {
    const { stdout } = await run("/bin/ps", ["-axww", "-o", "pid=,ppid=,args="], {
      timeout: 2000,
      maxBuffer: 8 * 1024 * 1024,
    });
    return parseProcessTable(stdout);
  } catch {
    return undefined;
  }
}

/** The nearest ancestor that is a macOS app bundle, such as Ghostty for a shell in its window. */
export function hostAppOf(
  pid: number,
  table: ReadonlyMap<number, ProcessEntry>,
): string | undefined {
  let current = table.get(pid)?.ppid;
  for (let depth = 0; current !== undefined && current > 1 && depth < MAX_DEPTH; depth++) {
    const entry = table.get(current);
    if (!entry) return undefined;
    const bundle = BUNDLE.exec(entry.args)?.[1];
    if (bundle) return APP_NAMES[bundle] ?? bundle;
    current = entry.ppid;
  }
  return undefined;
}
