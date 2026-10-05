import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createManualJob } from "../src/native/manual-job.js";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
function fixture() {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "sb-manual-job-")));
  dirs.push(dir);
  const root = join(dir, "native");
  const executable = join(dir, "Shellbell.app/Contents/MacOS/Shellbell");
  return {
    dir,
    root,
    executable,
    path: join(root, "manual.plist"),
    job: createManualJob(root, process.getuid!()),
  };
}
describe("private transient job definition", () => {
  it("refuses arbitrary executables before creating any file", () => {
    const f = fixture();
    expect(() => f.job.write(join(f.dir, "arbitrary-executable"))).toThrow();
    expect(existsSync(f.root)).toBe(false);
  });
  it("does not repair an unsafe root or accept a foreign owner", () => {
    const f = fixture();
    mkdirSync(f.root, { mode: 0o755 });
    expect(() => f.job.write(f.executable)).toThrow();
    expect(statSync(f.root).mode & 0o777).toBe(0o755);
    chmodSync(f.root, 0o700);
    const foreign = createManualJob(f.root, process.getuid!() + 1);
    expect(() => foreign.write(f.executable)).toThrow();
    expect(existsSync(f.path)).toBe(false);
  });
  it("inspection does not create a missing root", () => {
    const f = fixture();
    expect(f.job.inspect(f.executable)).toBe(false);
    expect(existsSync(f.root)).toBe(false);
  });
  it("writes only a private transient fixed-label definition with no state or environment", () => {
    const f = fixture();
    f.job.write(f.executable);
    expect(existsSync(f.path)).toBe(true);
    expect(statSync(f.root).mode & 0o777).toBe(0o700);
    expect(statSync(f.path).mode & 0o777).toBe(0o600);
    const xml = readFileSync(f.path, "utf8");
    expect(xml).toContain("<key>Label</key><string>sh.bilal.shellbell.host.manual</string>");
    expect(xml).toContain(
      `<string>${f.executable}</string><string>--service-run</string><string>manual</string>`,
    );
    expect(xml).toContain("<key>RunAtLoad</key><true/>");
    expect(xml).toContain("<key>KeepAlive</key><true/>");
    expect(xml).toContain("<key>ThrottleInterval</key><integer>10</integer>");
    expect(xml).not.toContain("EnvironmentVariables");
    expect(f.job.inspect(f.executable)).toBe(true);
    f.job.remove(f.executable);
    expect(existsSync(f.path)).toBe(false);
  });
  it.each(["malformed", "foreign", "mode", "label", "permissions", "symlink"])(
    "refuses %s definition without deleting or replacing it",
    (kind) => {
      const f = fixture();
      f.job.write(f.executable);
      if (!existsSync(f.root)) mkdirSync(f.root, { mode: 0o700 });
      let raw = existsSync(f.path) ? readFileSync(f.path, "utf8") : "fixture";
      if (kind === "malformed") raw = "not a plist";
      if (kind === "foreign") raw = raw.replace(f.executable, "/foreign");
      if (kind === "mode")
        raw = raw.replace("<string>manual</string>", "<string>persistent</string>");
      if (kind === "label") raw = raw.replace("host.manual", "foreign");
      writeFileSync(f.path, raw, { mode: 0o600 });
      if (kind === "permissions") chmodSync(f.path, 0o644);
      if (kind === "symlink") {
        renameSync(f.path, join(f.dir, "target"));
        symlinkSync(join(f.dir, "target"), f.path);
      }
      expect(() => f.job.write(f.executable)).toThrow();
      expect(() => f.job.remove(f.executable)).toThrow();
      expect(readFileSync(f.path, "utf8")).toBe(raw);
    },
  );
  it("detects replacement after inspection, even with identical bytes", () => {
    const f = fixture();
    f.job.write(f.executable);
    f.job.inspect(f.executable);
    if (!existsSync(f.root)) mkdirSync(f.root, { mode: 0o700 });
    const bytes = existsSync(f.path) ? readFileSync(f.path) : Buffer.from("fixture");
    if (existsSync(f.path)) renameSync(f.path, join(f.dir, "old"));
    writeFileSync(f.path, bytes, { mode: 0o600 });
    expect(() => f.job.remove(f.executable)).toThrow();
    expect(existsSync(f.path)).toBe(true);
  });
  it("rejects a symlink root without modifying its target", () => {
    const f = fixture();
    const target = join(f.dir, "target");
    mkdirSync(target, { mode: 0o700 });
    symlinkSync(target, f.root);
    expect(() => f.job.write(f.executable)).toThrow();
    expect(existsSync(join(target, "manual.plist"))).toBe(false);
  });
});
