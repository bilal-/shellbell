import { randomUUID } from "node:crypto";
import {
  closeSync,
  constants,
  fsyncSync,
  linkSync,
  mkdirSync,
  openSync,
  readlinkSync,
  realpathSync,
  renameSync,
  type Stats,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join } from "node:path";
import { boundedRead, optionalStat, sameFile } from "./host-files.js";
import {
  parseSystemdUnit,
  renderSystemdUnit,
  type SystemdLocation,
  type SystemdUnitDefinition,
} from "./systemd-unit.js";

/** Internal snapshots deliberately never form part of public service status. */
export interface SystemdFileSnapshot {
  unit: { stat: Stats; raw: Buffer; definition: SystemdUnitDefinition } | null;
  link: { stat: Stats; target: string | null; owned: boolean } | null;
  parents?: { path: string; stat: Stats }[];
}
function conflict(): never {
  throw new Error("shellbell: unsafe, foreign or concurrently changed systemd files");
}
function unchanged(a: Stats, b: Stats): boolean {
  return (
    sameFile(a, b) &&
    a.mode === b.mode &&
    a.uid === b.uid &&
    a.size === b.size &&
    a.mtimeMs === b.mtimeMs &&
    a.ctimeMs === b.ctimeMs
  );
}

export class SystemdFiles {
  constructor(
    readonly location: SystemdLocation,
    private readonly machineId: string,
  ) {}

  private directory(path: string, create = false): Stats | undefined {
    let st = optionalStat(path);
    if (!st && create) {
      this.directory(dirname(path), true);
      mkdirSync(path, { mode: 0o700 });
      st = optionalStat(path);
    }
    if (
      st &&
      (!st.isDirectory() ||
        st.isSymbolicLink() ||
        st.uid !== this.location.uid ||
        (st.mode & 0o022) !== 0)
    )
      conflict();
    return st;
  }

  private parents(create = false): { path: string; stat: Stats }[] {
    const paths = [
      this.location.home,
      this.location.configRoot,
      join(this.location.configRoot, "systemd"),
      this.location.unitDir,
      dirname(this.location.enablementPath),
    ];
    const result: { path: string; stat: Stats }[] = [];
    for (const path of paths) {
      const st = this.directory(path, create && path !== dirname(this.location.enablementPath));
      if (st) result.push({ path, stat: st });
    }
    return result;
  }

  inspect(): SystemdFileSnapshot {
    const parents = this.parents();
    const st = optionalStat(this.location.definitionPath);
    let unit: SystemdFileSnapshot["unit"] = null;
    if (st) {
      const raw = boundedRead(this.location.definitionPath, 64 * 1024, this.location.uid);
      const definition = parseSystemdUnit(raw);
      if (
        definition.machineId !== this.machineId ||
        !unchanged(st, optionalStat(this.location.definitionPath)!)
      )
        conflict();
      unit = { stat: st, raw, definition };
    }
    const linkStat = optionalStat(this.location.enablementPath);
    let link: SystemdFileSnapshot["link"] = null;
    if (linkStat) {
      const target = linkStat.isSymbolicLink() ? readlinkSync(this.location.enablementPath) : null;
      if (!unchanged(linkStat, optionalStat(this.location.enablementPath)!)) conflict();
      link = {
        stat: linkStat,
        target,
        owned: linkStat.uid === this.location.uid && target === this.location.definitionPath,
      };
    }
    for (const parent of parents) {
      const current = this.directory(parent.path);
      if (!current || !sameFile(parent.stat, current)) conflict();
    }
    return { unit, link, parents };
  }

  assertUnchanged(snapshot: SystemdFileSnapshot): void {
    const current = this.inspect();
    for (const parent of snapshot.parents ?? []) {
      const st = this.directory(parent.path);
      if (!st || !sameFile(parent.stat, st)) conflict();
    }
    if (!!current.unit !== !!snapshot.unit || !!current.link !== !!snapshot.link) conflict();
    if (
      current.unit &&
      snapshot.unit &&
      (!unchanged(current.unit.stat, snapshot.unit.stat) ||
        !current.unit.raw.equals(snapshot.unit.raw))
    )
      conflict();
    if (
      current.link &&
      snapshot.link &&
      (!unchanged(current.link.stat, snapshot.link.stat) ||
        current.link.target !== snapshot.link.target)
    )
      conflict();
  }

  matchesFragment(path: string): boolean {
    try {
      const st = optionalStat(path);
      return (
        !!st &&
        st.isFile() &&
        !st.isSymbolicLink() &&
        st.uid === this.location.uid &&
        (st.mode & 0o7777) === 0o600 &&
        join(realpathSync(dirname(path)), basename(path)) === this.location.definitionPath
      );
    } catch {
      return false;
    }
  }

  publish(before: SystemdFileSnapshot, definition: SystemdUnitDefinition): SystemdFileSnapshot {
    if (definition.machineId !== this.machineId || (before.link && !before.link.owned)) conflict();
    const raw = renderSystemdUnit(definition);
    this.assertUnchanged(before);
    this.parents(true);
    const temporary = `${this.location.definitionPath}.tmp-${randomUUID()}`;
    let owned: Stats | undefined;
    try {
      const fd = openSync(
        temporary,
        constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
        0o600,
      );
      try {
        owned = optionalStat(temporary);
        writeFileSync(fd, raw);
        fsyncSync(fd);
      } finally {
        closeSync(fd);
      }
      // Cooperative lifecycle writers hold the local guard. Portable Node rename
      // is not an atomic CAS against arbitrary same-user manual writers.
      this.assertUnchanged(before);
      if (before.unit) renameSync(temporary, this.location.definitionPath);
      else linkSync(temporary, this.location.definitionPath); // exclusive destination
    } finally {
      const current = optionalStat(temporary);
      if (owned && current && sameFile(owned, current)) unlinkSync(temporary);
    }
    return this.inspect();
  }

  setEnabled(before: SystemdFileSnapshot, enabled: boolean): SystemdFileSnapshot {
    this.assertUnchanged(before);
    if (before.link && !before.link.owned) conflict();
    if (enabled === !!before.link) return before;
    if (enabled) {
      if (!before.unit) conflict();
      this.directory(dirname(this.location.enablementPath), true);
      this.assertUnchanged(before);
      symlinkSync(this.location.definitionPath, this.location.enablementPath);
    } else {
      this.assertUnchanged(before);
      unlinkSync(this.location.enablementPath);
    }
    return this.inspect();
  }

  remove(before: SystemdFileSnapshot): SystemdFileSnapshot {
    this.assertUnchanged(before);
    if (before.link?.owned) conflict();
    if (before.unit) unlinkSync(this.location.definitionPath);
    return this.inspect();
  }

  restore(before: SystemdFileSnapshot, changed: SystemdFileSnapshot): void {
    try {
      this.assertUnchanged(changed);
      let current = changed;
      if (before.unit && !current.unit?.raw.equals(before.unit.raw))
        current = this.publish(current, before.unit.definition);
      if (!!current.link !== !!before.link) current = this.setEnabled(current, !!before.link);
      if (!before.unit) this.remove(current);
    } catch {
      // Preserve evidence separately, never overwrite a replacement. A missing
      // prior file has no private bytes to save.
      try {
        this.parents();
        if (before.unit)
          writeFileSync(
            `${this.location.definitionPath}.recovery-${randomUUID()}`,
            before.unit.raw,
            { flag: "wx", mode: 0o600 },
          );
      } catch {
        /* An unsafe directory cannot receive recovery evidence. */
      }
      throw new Error(
        "shellbell: unresolved systemd file recovery; inspect owned artifacts before retrying",
      );
    }
  }
}
