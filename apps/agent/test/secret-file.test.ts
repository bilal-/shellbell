import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

/** Lets a test make hard links fail the way some filesystems do. */
const links = vi.hoisted(() => ({
  error: null as null | string,
  /** Another process publishing, at the last moment this one inspects or creates `target`. */
  race: null as null | { target: string; publish: () => void },
  /** Makes the next write to this exact path fail, as a full disk would. */
  failWrite: null as null | string,
}));
vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  const raceAt = (path: unknown) => {
    const race = links.race;
    if (race && path === race.target) {
      links.race = null;
      links.failWrite = null;
      return race.publish;
    }
    return null;
  };
  return {
    ...actual,
    lstatSync: ((path: string, ...rest: unknown[]) => {
      const publish = raceAt(path);
      try {
        return (actual.lstatSync as (...args: unknown[]) => unknown)(path, ...rest);
      } finally {
        publish?.();
      }
    }) as typeof actual.lstatSync,
    openSync: ((path: string, ...rest: unknown[]) => {
      raceAt(path)?.();
      return (actual.openSync as (...args: unknown[]) => number)(path, ...rest);
    }) as typeof actual.openSync,
    writeSync: ((fd: number, ...rest: unknown[]) => {
      const target = links.failWrite;
      if (
        target &&
        actual.fstatSync(fd).ino === actual.statSync(target, { throwIfNoEntry: false })?.ino
      ) {
        links.failWrite = null;
        throw Object.assign(new Error("no space left"), { code: "ENOSPC" });
      }
      return (actual.writeSync as (...args: unknown[]) => number)(fd, ...rest);
    }) as typeof actual.writeSync,
    linkSync: (existing: string, target: string) => {
      if (links.error) throw Object.assign(new Error("link refused"), { code: links.error });
      return actual.linkSync(existing, target);
    },
  };
});

import { createSecretFile } from "../src/config.js";

const dirs: string[] = [];
const dir = () => {
  const value = mkdtempSync(join(tmpdir(), "sb-secret-"));
  dirs.push(value);
  return value;
};
afterEach(() => {
  links.error = null;
  links.race = null;
  for (const value of dirs.splice(0)) rmSync(value, { recursive: true, force: true });
});

describe("createSecretFile", () => {
  it("creates a private file once and leaves an existing one untouched", () => {
    const path = join(dir(), "identity.json");
    expect(createSecretFile(path, "first")).toBe(true);
    expect(createSecretFile(path, "second")).toBe(false);
    expect(readFileSync(path, "utf8")).toBe("first");
    expect(statSync(path).mode & 0o777).toBe(0o600);
  });

  it.each(["EPERM", "ENOTSUP", "EXDEV"])(
    "still creates the file where hard links fail with %s",
    (code) => {
      const parent = dir();
      const path = join(parent, "identity.json");
      links.error = code;
      expect(createSecretFile(path, "created")).toBe(true);
      expect(readFileSync(path, "utf8")).toBe("created");
      expect(statSync(path).mode & 0o777).toBe(0o600);
      expect(readdirSync(parent)).toEqual(["identity.json"]);
      writeFileSync(join(parent, "other"), "x");
      expect(createSecretFile(path, "replacement")).toBe(false);
      expect(readFileSync(path, "utf8")).toBe("created");
    },
  );

  it("creates the file owner read/write even under a restrictive umask", () => {
    const path = join(dir(), "identity.json");
    links.error = "EPERM";
    const previous = process.umask(0o277);
    try {
      expect(createSecretFile(path, "created")).toBe(true);
    } finally {
      process.umask(previous);
    }
    expect(statSync(path).mode & 0o777).toBe(0o600);
  });

  it("removes its partial file when writing fails where links are unsupported", () => {
    const parent = dir();
    const path = join(parent, "identity.json");
    links.error = "EPERM";
    links.failWrite = path;
    expect(() => createSecretFile(path, "created")).toThrow("no space left");
    // A later start can create the identity again instead of failing on a broken file.
    expect(readdirSync(parent)).toEqual([]);
    expect(createSecretFile(path, "created")).toBe(true);
    expect(readFileSync(path, "utf8")).toBe("created");
  });

  it("keeps a file another process created while links fail", () => {
    const path = join(dir(), "identity.json");
    links.error = "EPERM";
    links.race = { target: path, publish: () => writeFileSync(path, "winner", { mode: 0o600 }) };
    expect(createSecretFile(path, "loser")).toBe(false);
    expect(readFileSync(path, "utf8")).toBe("winner");
  });
});
