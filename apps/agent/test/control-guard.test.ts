import { randomUUID } from "node:crypto";
import fs from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { acquireControlGuard } from "../src/control-guard.js";

const deadPid = 2147483647;
const newSock = () => join(fs.mkdtempSync(join(tmpdir(), "sb-guard-")), "agent.sock");
function oldGuard(sock: string) {
  const marker = `owner-${deadPid}-${randomUUID()}`;
  fs.mkdirSync(`${sock}.lock`);
  fs.writeFileSync(join(`${sock}.lock`, marker), "");
  return marker;
}
afterEach(() => vi.restoreAllMocks());

describe("control operation guard", () => {
  it("publishes an already nonempty private guard and refuses a live owner", () => {
    const sock = newSock();
    const rename = fs.renameSync;
    vi.spyOn(fs, "renameSync").mockImplementation((from, to) => {
      expect(fs.readdirSync(from)).toHaveLength(1);
      return rename(from, to);
    });
    const release = acquireControlGuard(sock);
    const guard = `${sock}.lock`;
    expect(fs.statSync(guard).mode & 0o777).toBe(0o700);
    expect(fs.statSync(join(guard, fs.readdirSync(guard)[0]!)).mode & 0o777).toBe(0o600);
    expect(() => acquireControlGuard(sock)).toThrow(/busy|running/);
    expect(fs.readdirSync(dirname(sock))).toEqual([basename(guard)]);
    release();
    release();
    expect(fs.existsSync(guard)).toBe(false);
  });

  it("recovers dead owners and empty abandoned guards", () => {
    const sock = newSock();
    oldGuard(sock);
    acquireControlGuard(sock)();
    fs.mkdirSync(`${sock}.lock`);
    acquireControlGuard(sock)();
    expect(fs.existsSync(`${sock}.lock`)).toBe(false);
  });

  it("bounds repeated vanished-guard races and removes its own candidate", () => {
    const sock = newSock();
    let attempts = 0;
    vi.spyOn(fs, "renameSync").mockImplementation(() => {
      attempts++;
      throw Object.assign(new Error("raced"), { code: "ENOTEMPTY" });
    });
    expect(() => acquireControlGuard(sock)).toThrow(/three attempts/);
    expect(attempts).toBe(3);
    expect(fs.readdirSync(dirname(sock))).toEqual([]);
  });

  it("cleans only its candidate after marker preparation fails", () => {
    const sock = newSock();
    fs.writeFileSync(join(dirname(sock), "keep"), "precious");
    vi.spyOn(fs, "writeFileSync").mockImplementation(() => {
      throw new Error("disk full");
    });
    expect(() => acquireControlGuard(sock)).toThrow(/disk full/);
    expect(fs.readdirSync(dirname(sock))).toEqual(["keep"]);
  });

  it.each(["unknown", "owner-0-bad", `owner-${process.pid}-${randomUUID()}`])(
    "preserves unknown or live marker %s",
    (marker) => {
      const sock = newSock();
      fs.mkdirSync(`${sock}.lock`);
      fs.writeFileSync(join(`${sock}.lock`, marker), "");
      expect(() => acquireControlGuard(sock)).toThrow();
      expect(fs.readdirSync(`${sock}.lock`)).toEqual([marker]);
    },
  );

  it("does not follow guard or marker symlinks", () => {
    const sock = newSock();
    const target = `${sock}.target`;
    fs.mkdirSync(target);
    fs.symlinkSync(target, `${sock}.lock`);
    expect(() => acquireControlGuard(sock)).toThrow();
    fs.unlinkSync(`${sock}.lock`);
    fs.mkdirSync(`${sock}.lock`);
    fs.symlinkSync(target, join(`${sock}.lock`, `owner-${deadPid}-${randomUUID()}`));
    expect(() => acquireControlGuard(sock)).toThrow();
    expect(fs.existsSync(target)).toBe(true);
  });

  it("release cannot remove a replacement guard", () => {
    const sock = newSock();
    const release = acquireControlGuard(sock);
    fs.renameSync(`${sock}.lock`, `${sock}.old`);
    const replacement = acquireControlGuard(sock);
    release();
    expect(() => acquireControlGuard(sock)).toThrow(/busy/);
    replacement();
  });

  it("a delayed stale reaper cannot unlink a newly published owner", () => {
    const sock = newSock();
    const marker = oldGuard(sock);
    const unlink = fs.unlinkSync;
    let replacement: (() => void) | undefined;
    vi.spyOn(fs, "unlinkSync").mockImplementation((path) => {
      if (String(path) === join(`${sock}.lock`, marker) && !replacement) {
        unlink(path);
        fs.rmdirSync(`${sock}.lock`);
        replacement = acquireControlGuard(sock);
      }
      return unlink(path);
    });
    expect(() => acquireControlGuard(sock)).toThrow(/busy/);
    expect(fs.readdirSync(`${sock}.lock`)).toHaveLength(1);
    replacement?.();
  });

  it("reaps only recognized dead candidates with matching contents", () => {
    const sock = newSock();
    const id = randomUUID();
    const candidate = `${sock}.lock-candidate-${deadPid}-${id}`;
    fs.mkdirSync(candidate);
    fs.writeFileSync(join(candidate, `owner-${deadPid}-${id}`), "");
    const unknown = `${sock}.lock-candidate-${deadPid}-${randomUUID()}`;
    fs.mkdirSync(unknown);
    fs.writeFileSync(join(unknown, "precious"), "keep");
    const live = `${sock}.lock-candidate-${process.pid}-${randomUUID()}`;
    fs.mkdirSync(live);
    const empty = `${sock}.lock-candidate-${deadPid}-${randomUUID()}`;
    fs.mkdirSync(empty);
    const symlink = `${sock}.lock-candidate-${deadPid}-${randomUUID()}`;
    fs.symlinkSync(unknown, symlink);
    acquireControlGuard(sock)();
    expect(fs.existsSync(candidate)).toBe(false);
    expect(fs.existsSync(empty)).toBe(false);
    expect(fs.lstatSync(symlink).isSymbolicLink()).toBe(true);
    expect(fs.readFileSync(join(unknown, "precious"), "utf8")).toBe("keep");
    expect(fs.existsSync(live)).toBe(true);
  });

  it.each(["EPERM", "EIO"])("does not infer death from %s", (code) => {
    const sock = newSock();
    const marker = oldGuard(sock);
    vi.spyOn(process, "kill").mockImplementation(() => {
      throw Object.assign(new Error(code), { code });
    });
    expect(() => acquireControlGuard(sock)).toThrow();
    expect(fs.readdirSync(`${sock}.lock`)).toEqual([marker]);
  });
});
