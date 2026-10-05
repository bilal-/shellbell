import { randomUUID } from "node:crypto";
import fs from "node:fs";
import { basename, dirname, join } from "node:path";

const ownerPattern =
  /^owner-([1-9][0-9]*)-([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/;

export function validPid(text: string): number | null {
  if (!/^[1-9][0-9]*$/.test(text)) return null;
  const pid = Number(text);
  return Number.isInteger(pid) && pid <= 2147483647 ? pid : null;
}

/** Only ESRCH proves death. Unknown errors must never grant ownership. */
export function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ESRCH") return false;
    if (code === "EPERM") return true;
    throw error;
  }
}

function removeMarker(directory: string, marker: string): void {
  try {
    fs.unlinkSync(join(directory, marker));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  try {
    fs.rmdirSync(directory);
  } catch (error) {
    if (!["ENOENT", "ENOTEMPTY", "EEXIST"].includes((error as NodeJS.ErrnoException).code ?? ""))
      throw error;
  }
}

function reapCandidates(sockPath: string): void {
  const prefix = `${basename(sockPath)}.lock-candidate-`;
  for (const name of fs.readdirSync(dirname(sockPath))) {
    if (!name.startsWith(prefix)) continue;
    const marker = `owner-${name.slice(prefix.length)}`;
    const match = ownerPattern.exec(marker);
    const pid = match && validPid(match[1]!);
    if (!pid) continue;
    const path = join(dirname(sockPath), name);
    try {
      if (processAlive(pid) || !fs.lstatSync(path).isDirectory()) continue;
      const entries = fs.readdirSync(path);
      if (entries.length === 0) fs.rmdirSync(path);
      else if (
        entries.length === 1 &&
        entries[0] === marker &&
        fs.lstatSync(join(path, marker)).isFile()
      )
        removeMarker(path, marker);
    } catch {
      // Ambiguous or raced candidates are harmless; never broaden cleanup.
    }
  }
}

/** A published guard is already nonempty: rename cannot replace another live
 * guard. Stale cleanup removes only the observed unique marker; rmdir cannot
 * remove a replacement owner's nonempty directory. Local cooperative POSIX only. */
export function acquireControlGuard(sockPath: string): () => void {
  const guard = `${sockPath}.lock`;
  const token = `${process.pid}-${randomUUID()}`;
  const candidate = `${sockPath}.lock-candidate-${token}`;
  const marker = `owner-${token}`;
  fs.mkdirSync(candidate, { mode: 0o700 });
  let published = false;
  try {
    fs.writeFileSync(join(candidate, marker), "", { mode: 0o600, flag: "wx" });
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        fs.renameSync(candidate, guard);
        published = true;
        try {
          reapCandidates(sockPath);
        } catch {
          // Optional abandoned-preparation recovery cannot invalidate ownership.
        }
        return () => removeMarker(guard, marker);
      } catch (error) {
        if (!["EEXIST", "ENOTEMPTY"].includes((error as NodeJS.ErrnoException).code ?? ""))
          throw error;
      }
      try {
        if (!fs.lstatSync(guard).isDirectory())
          throw new Error(`Invalid control guard ${guard}; inspect it before retrying`);
        const entries = fs.readdirSync(guard);
        if (entries.length === 0) continue;
        const observed = entries[0]!;
        const match = ownerPattern.exec(observed);
        const pid = match && validPid(match[1]!);
        if (entries.length !== 1 || !pid || !fs.lstatSync(join(guard, observed)).isFile())
          throw new Error(
            `Invalid control guard ${guard}; inspect its owner marker before retrying`,
          );
        if (processAlive(pid)) throw new Error(`Control endpoint busy (guard owner pid ${pid})`);
        removeMarker(guard, observed);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
    }
    throw new Error(`Control endpoint busy; could not acquire ${guard} after three attempts`);
  } finally {
    if (!published) removeMarker(candidate, marker);
  }
}
