import { mkdirSync, type Stats, unlinkSync } from "node:fs";
import { dirname, join } from "node:path";
import { writeSecretFile } from "../config.js";
import { boundedRead, optionalStat, privateDirectory, sameFile } from "../host-files.js";
import { NativeControllerError, NativePathSchema } from "./protocol.js";

export const MANUAL_LABEL = "sh.bilal.shellbell.host.manual";
export function assertNativeAncestors(path: string): void {
  if (!NativePathSchema.safeParse(path).success || path !== join(path)) unsafe();
  for (let current = path; ; current = dirname(current)) {
    const stat = optionalStat(current);
    if (stat && (!stat.isDirectory() || stat.isSymbolicLink())) unsafe();
    if (dirname(current) === current) break;
  }
}
function unsafe(): never {
  throw new NativeControllerError("unsafe-state");
}
function xml(value: string): string {
  if (
    !NativePathSchema.safeParse(value).success ||
    [...value].some((char) => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127)
  )
    unsafe();
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}
function definition(executable: string): Buffer {
  if (
    executable !== join(executable) ||
    !executable.endsWith("/Shellbell.app/Contents/MacOS/Shellbell")
  )
    unsafe();
  return Buffer.from(`<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>Label</key><string>${MANUAL_LABEL}</string>
<key>ProgramArguments</key><array><string>${xml(executable)}</string><string>--service-run</string><string>manual</string></array>
<key>RunAtLoad</key><true/>
<key>KeepAlive</key><true/>
<key>ThrottleInterval</key><integer>10</integer>
</dict></plist>
`);
}
interface Fingerprint {
  stat: Stats;
  raw: Buffer;
}
function same(a: Fingerprint | null, b: Fingerprint | null): boolean {
  return a === null || b === null
    ? a === b
    : sameFile(a.stat, b.stat) &&
        a.stat.mode === b.stat.mode &&
        a.stat.uid === b.stat.uid &&
        a.stat.size === b.stat.size &&
        a.stat.mtimeMs === b.stat.mtimeMs &&
        a.stat.ctimeMs === b.stat.ctimeMs &&
        a.raw.equals(b.raw);
}
/** Only this adapter's canonical private definition is admitted; unknown files are never repaired. */
export function createManualJob(root: string, uid: number) {
  const path = join(root, "manual.plist");
  let expected: Fingerprint | null | undefined;
  const read = (executable: string): Fingerprint | null => {
    try {
      assertNativeAncestors(root);
      if (!optionalStat(root)) return null;
      privateDirectory(root, uid);
      const stat = optionalStat(path);
      if (!stat) return null;
      const raw = boundedRead(path, 65536, uid);
      if (!raw.equals(definition(executable))) unsafe();
      return { stat, raw };
    } catch {
      return unsafe();
    }
  };
  const observe = (executable: string): Fingerprint | null => {
    const current = read(executable);
    if (expected !== undefined && !same(expected, current)) unsafe();
    expected = current;
    return current;
  };
  return {
    path,
    inspect(executable: string): boolean {
      return observe(executable) !== null;
    },
    write(executable: string): void {
      const bytes = definition(executable);
      const prior = observe(executable);
      assertNativeAncestors(root);
      if (!optionalStat(root)) mkdirSync(root, { recursive: true, mode: 0o700 });
      const parent = privateDirectory(root, uid);
      writeSecretFile(path, bytes, () => {
        assertNativeAncestors(root);
        if (!sameFile(parent, privateDirectory(root, uid)) || !same(prior, read(executable)))
          unsafe();
      });
      expected = read(executable);
      if (!expected?.raw.equals(bytes)) unsafe();
    },
    remove(executable: string): void {
      const current = observe(executable);
      if (!current) return;
      if (!same(current, read(executable))) unsafe();
      unlinkSync(path);
      expected = null;
    },
  };
}
