import fs, {
  closeSync,
  existsSync,
  fstatSync,
  linkSync,
  lstatSync,
  mkdtempSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
  writeSync,
} from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import * as config from "../src/config.js";
import { createLogger } from "../src/log.js";

function withHeldLog(
  run: (file: string, held: number, dir: string) => void,
  filePath = (dir: string) => join(dir, "agent.log"),
): void {
  const dir = mkdtempSync(join(tmpdir(), "sb-log-"));
  let held: number | undefined;
  try {
    const file = filePath(dir);
    held = openSync(file, "a", 0o600);
    run(file, held, dir);
  } finally {
    try {
      if (held !== undefined) closeSync(held);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }
}

describe("logger", () => {
  it("cleans an owned descriptor fixture if opening the log fails", () => {
    let dir = "";
    expect(() =>
      withHeldLog(
        () => {
          throw new Error("fixture callback must not run");
        },
        (created) => {
          dir = created;
          return join(created, "missing", "agent.log");
        },
      ),
    ).toThrow(/ENOENT/);
    expect(dir).not.toBe("");
    expect(existsSync(dir)).toBe(false);
  });

  it("cleans an owned descriptor fixture if closing the log fails", () => {
    let dir = "";
    expect(() =>
      withHeldLog((_file, held, created) => {
        dir = created;
        closeSync(held);
      }),
    ).toThrow(/EBADF/);
    expect(dir).not.toBe("");
    expect(existsSync(dir)).toBe(false);
  });

  it("preserves inherited descriptors when rotating", () => {
    withHeldLog((file, held) => {
      writeSync(held, Buffer.alloc(1_048_576, 120));
      createLogger({ file, stdout: false }).info("rotate");
      writeSync(held, "inherited-marker\n");

      expect(fstatSync(held).ino).toBe(statSync(file).ino);
      expect(readFileSync(file, "utf8")).toContain("inherited-marker");
    });
  });

  it("keeps inherited output visible and five private bounded archives after repeated rotations", () => {
    withHeldLog((file, held) => {
      const log = createLogger({ file, stdout: false });
      const original = fstatSync(held);
      for (let n = 0; n < 7; n++) {
        writeSync(held, Buffer.alloc(1_048_576, 65 + n));
        log.info("rotation", { n });
        const marker = `inherited-${n}\n`;
        writeSync(held, marker);

        const active = statSync(file);
        expect(active.ino).toBe(original.ino);
        expect(active.nlink).toBeGreaterThan(0);
        expect(active.mode & 0o777).toBe(0o600);
        expect(readFileSync(file, "utf8")).toContain(marker);
        expect(JSON.parse(readFileSync(file, "utf8").split("\n")[0] as string)).toMatchObject({
          level: "info",
          msg: "rotation",
          n,
        });
      }
      for (let n = 1; n <= 5; n++) {
        const archive = statSync(`${file}.${n}`);
        expect(archive.size).toBeLessThanOrEqual(1_048_576);
        expect(archive.mode & 0o777).toBe(0o600);
      }
      expect(existsSync(`${file}.6`)).toBe(false);
    });
  });

  it("retains only the newest megabyte from an oversized inherited burst", () => {
    withHeldLog((file, held) => {
      writeSync(held, Buffer.alloc(1_048_776, 120));
      writeSync(held, "newest-burst-end\n");
      createLogger({ file, stdout: false }).info("after burst");

      const archive = readFileSync(`${file}.1`);
      expect(archive.byteLength).toBe(1_048_576);
      expect(archive.subarray(-17).toString()).toBe("newest-burst-end\n");
      expect(JSON.parse(readFileSync(file, "utf8").trim()).msg).toBe("after burst");
    });
  });

  it("preserves active bytes when private archive publication fails", () => {
    withHeldLog((file, held) => {
      writeSync(held, Buffer.alloc(1_048_576, 120));
      const stage = `${file}.1.tmp-${process.pid}`;
      writeFileSync(stage, "belongs to another writer");
      createLogger({ file, stdout: false }).info("after failed rotation");
      writeSync(held, "still visible\n");

      expect(readFileSync(stage, "utf8")).toBe("belongs to another writer");
      expect(statSync(file).size).toBeGreaterThan(1_048_576);
      expect(readFileSync(file, "utf8")).toContain("still visible");
      expect(existsSync(`${file}.1`)).toBe(false);
    });
  });

  it("does not rotate or append through a symlinked active path", () => {
    const dir = mkdtempSync(join(tmpdir(), "sb-log-"));
    const file = join(dir, "agent.log");
    const target = join(dir, "target.log");
    try {
      writeFileSync(target, Buffer.alloc(1_048_576, 120));
      symlinkSync(target, file);
      createLogger({ file, stdout: false }).info("after symlink");

      expect(lstatSync(file).isSymbolicLink()).toBe(true);
      expect(statSync(target).size).toBe(1_048_576);
      expect(existsSync(`${file}.1`)).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("does not append, rotate or chmod a multiply-linked log", () => {
    const dir = mkdtempSync(join(tmpdir(), "sb-log-links-"));
    const file = join(dir, "agent.log");
    const target = join(dir, "target.log");
    try {
      writeFileSync(target, Buffer.alloc(1_048_576, 120), { mode: 0o644 });
      linkSync(target, file);
      const before = statSync(target);
      createLogger({ file, stdout: false }).warn("not for target");
      expect(statSync(target).size).toBe(before.size);
      expect(statSync(target).mode).toBe(before.mode);
      expect(existsSync(`${file}.1`)).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("tightens an owned ordinary log before writing below the rotation threshold", () => {
    const dir = mkdtempSync(join(tmpdir(), "sb-log-mode-"));
    const file = join(dir, "agent.log");
    try {
      writeFileSync(file, "existing\n", { mode: 0o644 });
      createLogger({ file, stdout: false }).info("private append");
      expect(statSync(file).mode & 0o777).toBe(0o600);
      expect(readFileSync(file, "utf8")).toContain("private append");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("writes only its admitted descriptor if the pathname is swapped immediately before append", () => {
    const dir = mkdtempSync(join(tmpdir(), "sb-log-race-"));
    const file = join(dir, "agent.log");
    const retired = join(dir, "retired.log");
    const target = join(dir, "target.log");
    const append = fs.appendFileSync;
    let raced = false;
    let restore: (() => void) | undefined;
    try {
      writeFileSync(file, "original\n", { mode: 0o600 });
      writeFileSync(target, "untouched\n", { mode: 0o600 });
      const spy = vi.spyOn(fs, "appendFileSync").mockImplementation((path, data, options) => {
        raced = true;
        renameSync(file, retired);
        symlinkSync(target, file);
        return append(path, data, options);
      });
      syncBuiltinESMExports();
      restore = () => {
        spy.mockRestore();
        syncBuiltinESMExports();
      };
      createLogger({ file, stdout: false }).info("admitted append");
      expect(raced).toBe(true);
      expect(readFileSync(target, "utf8")).toBe("untouched\n");
      expect(readFileSync(retired, "utf8")).toContain("admitted append");
      expect(lstatSync(file).isSymbolicLink()).toBe(true);
    } finally {
      restore?.();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("does not truncate a former inode after the active path is replaced", () => {
    withHeldLog((file, held, dir) => {
      const retired = join(dir, "retired.log");
      const publish = config.writeSecretFile;
      const spy = vi.spyOn(config, "writeSecretFile").mockImplementation((path, bytes) => {
        publish(path, bytes);
        renameSync(file, retired);
        writeFileSync(file, "replacement\n", { mode: 0o600 });
      });
      try {
        writeSync(held, Buffer.alloc(1_048_576, 120));
        createLogger({ file, stdout: false }).info("after replacement");

        expect(statSync(retired).ino).toBe(fstatSync(held).ino);
        expect(statSync(retired).size).toBe(1_048_576);
        expect(readFileSync(file, "utf8")).toContain("replacement\n");
        expect(JSON.parse(readFileSync(file, "utf8").trim().split("\n")[1] as string).msg).toBe(
          "after replacement",
        );
      } finally {
        spy.mockRestore();
      }
    });
  });

  it("writes json lines and rotates at 1 MB", () => {
    const dir = mkdtempSync(join(tmpdir(), "sb-log-"));
    const file = join(dir, "agent.log");
    writeFileSync(file, "x".repeat(1_048_600));
    const log = createLogger({ file, stdout: false });
    log.info("hello", { n: 1 });
    expect(existsSync(`${file}.1`)).toBe(true);
    const line = JSON.parse(readFileSync(file, "utf8").trim());
    expect(line).toMatchObject({ level: "info", msg: "hello", n: 1 });
    expect(typeof line.t).toBe("string");
  });
  it("debug is dropped unless verbose; child merges fields", () => {
    const dir = mkdtempSync(join(tmpdir(), "sb-log-"));
    const file = join(dir, "agent.log");
    const log = createLogger({ file, stdout: false }).child({ phone: "abc" });
    log.debug("nope");
    log.warn("yes");
    const lines = readFileSync(file, "utf8").trim().split("\n");
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0] as string)).toMatchObject({ level: "warn", phone: "abc" });
  });

  it("keeps opt-in stdout formatting and verbose child output", () => {
    const output = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    try {
      const log = createLogger({ stdout: true, verbose: true }).child({ phone: "abc" });
      log.debug("visible");
      expect(output).toHaveBeenCalledOnce();
      expect(output.mock.calls[0]?.[0]).toMatch(/debug\s+visible \{"phone":"abc"\}\n$/);
    } finally {
      output.mockRestore();
    }
  });
});
