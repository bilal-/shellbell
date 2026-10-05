import { type ChildProcess, fork } from "node:child_process";
import fs from "node:fs";
import net, { createConnection, createServer, type Server, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as config from "../src/config.js";
import { ControlEndpoint } from "../src/control-endpoint.js";
import { acquireControlGuard } from "../src/control-guard.js";
import { createLogger } from "../src/log.js";

const log = createLogger({ stdout: false });
const endpoints: ControlEndpoint[] = [];
const children: ChildProcess[] = [];
const rawServers: Server[] = [];
const clients: Socket[] = [];
const dirs: string[] = [];
function paths() {
  const dir = fs.mkdtempSync(join(tmpdir(), "sb-end-"));
  dirs.push(dir);
  return { dir, sock: join(dir, "agent.sock"), pid: join(dir, "agent.pid") };
}
function endpoint(sock: string, pid?: string) {
  const result = new ControlEndpoint(sock, (s) => s.end("owner\n"), log, pid);
  endpoints.push(result);
  return result;
}
async function connect(sock: string) {
  const socket = createConnection(sock);
  clients.push(socket);
  await new Promise<void>((resolve, reject) => {
    socket.once("connect", resolve);
    socket.once("error", reject);
  });
  return socket;
}
async function raw(sock: string) {
  const server = createServer((s) => {
    clients.push(s);
    s.on("error", () => {});
  });
  rawServers.push(server);
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(sock, resolve);
  });
  return server;
}
async function child() {
  const result = fork(new URL("./fakes/control-owner-child.ts", import.meta.url), [], {
    execArgv: ["--import", "tsx"],
    stdio: ["ignore", "ignore", "pipe", "ipc"],
  });
  children.push(result);
  await new Promise((resolve) => result.once("message", resolve));
  return result;
}
function startChild(child: ChildProcess, sock: string, pid?: string, raw = false) {
  const response = new Promise<{ ready?: boolean; error?: string }>((resolve) =>
    child.once("message", resolve),
  );
  child.send({ command: "start", sock, pid, raw });
  return response;
}
async function exitChild(child: ChildProcess) {
  const exited = new Promise((resolve) => child.once("exit", resolve));
  child.send({ command: "exit" });
  await exited;
}
afterEach(async () => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  for (const client of clients.splice(0)) client.destroy();
  for (const e of endpoints.splice(0)) await e.stop();
  for (const server of rawServers.splice(0))
    await new Promise<void>((resolve) => server.close(() => resolve()));
  for (const c of children.splice(0))
    if (c.exitCode === null && c.signalCode === null) await exitChild(c);
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe("control endpoint ownership", () => {
  it("removes its published socket and PID if ownership admission changed during bind", async () => {
    const { sock, pid, dir } = paths();
    const e = new ControlEndpoint(
      sock,
      () => {},
      log,
      pid,
      () => {
        if (fs.existsSync(sock)) throw new Error("ownership changed during bind");
      },
    );
    endpoints.push(e);
    await expect(e.start()).rejects.toThrow(/ownership changed/);
    expect(fs.existsSync(sock)).toBe(false);
    expect(fs.existsSync(pid)).toBe(false);
    expect(fs.readdirSync(dir)).toEqual([]);
  });

  it("refuses a live silent listener without replacing it", async () => {
    const { sock } = paths();
    await raw(sock);
    const identity = fs.lstatSync(sock).ino;
    const e = endpoint(sock);
    await expect(e.start()).rejects.toThrow(/busy|running|in use/);
    await e.stop();
    expect(fs.lstatSync(sock).ino).toBe(identity);
    await connect(sock);
  });

  it.each(["file", "symlink", "directory"])("preserves a public %s", async (kind) => {
    const { sock, dir } = paths();
    if (kind === "file") fs.writeFileSync(sock, "precious");
    if (kind === "directory") fs.mkdirSync(sock);
    if (kind === "symlink") fs.symlinkSync(join(dir, "missing"), sock);
    const identity = fs.lstatSync(sock).ino;
    await expect(endpoint(sock).start()).rejects.toThrow(/socket/);
    expect(fs.lstatSync(sock).ino).toBe(identity);
  });

  it.each(["garbage", "0", "-1", "2147483648", "1e3", ""])(
    "preserves malformed PID %j",
    async (value) => {
      const { sock, pid } = paths();
      fs.writeFileSync(pid, value);
      await expect(endpoint(sock, pid).start()).rejects.toThrow(/PID|pid/);
      expect(fs.readFileSync(pid, "utf8")).toBe(value);
      expect(fs.existsSync(sock)).toBe(false);
    },
  );

  it("refuses live PID even without a socket and refuses PID symlinks", async () => {
    const { sock, pid, dir } = paths();
    fs.writeFileSync(pid, String(process.pid));
    await expect(endpoint(sock, pid).start()).rejects.toThrow(/running/);
    fs.renameSync(pid, join(dir, "target"));
    fs.symlinkSync(join(dir, "target"), pid);
    await expect(endpoint(sock, pid).start()).rejects.toThrow(/PID|pid/);
    expect(fs.lstatSync(pid).isSymbolicLink()).toBe(true);
  });

  it("publishes mode 0600 PID/socket and removes only owned resources", async () => {
    const { sock, pid, dir } = paths();
    const e = endpoint(sock, pid);
    const mask = process.umask();
    await e.start();
    expect(process.umask()).toBe(mask);
    expect(fs.readFileSync(pid, "utf8")).toBe(String(process.pid));
    expect(fs.statSync(pid).mode & 0o777).toBe(0o600);
    expect(fs.statSync(sock).mode & 0o777).toBe(0o600);
    const privateName = fs.readdirSync(dir).find((name) => /^\.s[A-Za-z0-9_-]{8}$/.test(name))!;
    expect(fs.statSync(join(dir, privateName)).ino).toBe(fs.statSync(sock).ino);
    await e.stop();
    await e.stop();
    expect(fs.readdirSync(dir)).toEqual([]);
  });

  it("recovers a crashed child endpoint and its matching private hard link", async () => {
    const { sock, pid, dir } = paths();
    const c = await child();
    expect(await startChild(c, sock, pid)).toEqual({ ready: true });
    const oldInode = fs.statSync(sock).ino;
    await exitChild(c);
    fs.writeFileSync(join(dir, ".sUNKNOWN!"), "preserve");
    const unrelated = join(dir, ".sOTHER123");
    await raw(unrelated);
    const unrelatedInode = fs.statSync(unrelated).ino;
    const e = endpoint(sock, pid);
    await e.start();
    expect(fs.statSync(sock).ino).not.toBe(oldInode);
    expect(fs.readFileSync(join(dir, ".sUNKNOWN!"), "utf8")).toBe("preserve");
    expect(fs.readdirSync(dir).filter((name) => /^\.s[A-Za-z0-9_-]{8}$/.test(name))).toHaveLength(
      2,
    );
    expect(fs.statSync(unrelated).ino).toBe(unrelatedInode);
    await connect(unrelated);
    await connect(sock);
  });

  it("recovers a stale legacy public-only socket", async () => {
    const { sock } = paths();
    const c = await child();
    expect(await startChild(c, sock, undefined, true)).toEqual({ ready: true });
    await exitChild(c);
    await endpoint(sock).start();
    await connect(sock);
  });

  it("serializes stop during start and supports stop before start", async () => {
    const { sock, pid, dir } = paths();
    const e = endpoint(sock, pid);
    await e.stop();
    const starting = e.start();
    const stopping = e.stop();
    await Promise.all([starting, stopping]);
    expect(fs.readdirSync(dir)).toEqual([]);
  });

  it("destroys idle ordinary clients on stop", async () => {
    const { sock } = paths();
    const e = new ControlEndpoint(sock, () => {}, log);
    endpoints.push(e);
    await e.start();
    const client = await connect(sock);
    const closed = new Promise((resolve) => client.once("close", resolve));
    await e.stop();
    await closed;
  });

  it("closes its private listener when guard busy without harming a replacement", async () => {
    const { sock, pid } = paths();
    const e = endpoint(sock, pid);
    await e.start();
    fs.unlinkSync(sock);
    fs.unlinkSync(pid);
    const replacement = endpoint(sock, pid);
    await replacement.start();
    const release = acquireControlGuard(sock);
    try {
      await expect(e.stop()).rejects.toThrow(/busy/);
    } finally {
      release();
    }
    await connect(sock);
    expect(fs.readFileSync(pid, "utf8")).toBe(String(process.pid));
    await e.stop();
    await connect(sock);
  });

  it("retries owned cleanup after guard busy", async () => {
    const { sock, pid } = paths();
    const e = endpoint(sock, pid);
    await e.start();
    const release = acquireControlGuard(sock);
    try {
      await expect(e.stop()).rejects.toThrow(/busy/);
    } finally {
      release();
    }
    expect(fs.existsSync(sock)).toBe(true);
    expect(fs.existsSync(pid)).toBe(true);
    await e.stop();
    expect(fs.existsSync(sock)).toBe(false);
    expect(fs.existsSync(pid)).toBe(false);
  });

  it("does not persist filesystem exception text when cleanup fails", async () => {
    const { sock, pid, dir } = paths();
    const file = join(dir, "agent.log");
    const e = new ControlEndpoint(
      sock,
      (socket) => socket.end(),
      createLogger({ file, stdout: false }),
      pid,
    );
    endpoints.push(e);
    await e.start();
    const unlink = fs.unlinkSync;
    const fault = vi.spyOn(fs, "unlinkSync").mockImplementation((path) => {
      if (path === sock) throw new Error("PRIVATE_FILESYSTEM_SENTINEL");
      return unlink(path);
    });
    try {
      await expect(e.stop()).rejects.toThrow("PRIVATE_FILESYSTEM_SENTINEL");
      const logged = fs.readFileSync(file, "utf8");
      expect(logged).not.toContain("PRIVATE_FILESYSTEM_SENTINEL");
      expect(logged).toContain('"error":"Error"');
    } finally {
      fault.mockRestore();
    }
  });

  it("leaves raced-in public files untouched and rolls back its private listener", async () => {
    const { sock, dir } = paths();
    const link = fs.linkSync;
    vi.spyOn(fs, "linkSync").mockImplementation((from, to) => {
      fs.writeFileSync(to, "raced");
      return link(from, to);
    });
    await expect(endpoint(sock).start()).rejects.toThrow();
    expect(fs.readFileSync(sock, "utf8")).toBe("raced");
    expect(fs.readdirSync(dir)).toEqual(["agent.sock"]);
  });

  it("rolls back publication on PID write failure without changing legacy PID", async () => {
    const { sock, pid, dir } = paths();
    fs.writeFileSync(pid, "2147483647");
    vi.spyOn(config, "writeSecretFile").mockImplementation(() => {
      throw new Error("disk full");
    });
    await expect(endpoint(sock, pid).start()).rejects.toThrow(/disk full/);
    expect(fs.readdirSync(dir)).toEqual(["agent.pid"]);
    expect(fs.readFileSync(pid, "utf8")).toBe("2147483647");
  });

  it.each(["file", "symlink"])(
    "preserves an unknown PID staging %s and rolls back startup",
    async (kind) => {
      const { sock, pid, dir } = paths();
      const staging = `${pid}.tmp-${process.pid}`;
      const sentinel = kind === "file" ? staging : join(dir, "sentinel");
      fs.writeFileSync(sentinel, "untouched", { mode: 0o640 });
      if (kind === "symlink") fs.symlinkSync(sentinel, staging);
      const stagingIdentity = fs.lstatSync(staging);
      const entries = fs.readdirSync(dir).sort();
      const link = fs.linkSync;
      let privatePath!: string;
      vi.spyOn(fs, "linkSync").mockImplementation((from, to) => {
        privatePath = String(from);
        return link(from, to);
      });
      const e = endpoint(sock, pid);
      await expect(e.start()).rejects.toThrow(/EEXIST/);
      expect(fs.readFileSync(sentinel, "utf8")).toBe("untouched");
      expect(fs.statSync(sentinel).mode & 0o777).toBe(0o640);
      expect(fs.lstatSync(staging).ino).toBe(stagingIdentity.ino);
      expect(fs.lstatSync(staging).isSymbolicLink()).toBe(kind === "symlink");
      expect(fs.existsSync(sock)).toBe(false);
      expect(fs.existsSync(pid)).toBe(false);
      expect(fs.readdirSync(dir).sort()).toEqual(entries);
      await expect(connect(privatePath)).rejects.toMatchObject({ code: "ENOENT" });
      await e.stop();
      expect(fs.readdirSync(dir).sort()).toEqual(entries);
    },
  );

  it("restores umask after synchronous binding failure", async () => {
    const { sock, dir } = paths();
    const mask = process.umask();
    vi.spyOn(net.Server.prototype, "listen").mockImplementation(() => {
      throw new Error("bind failed");
    });
    await expect(endpoint(sock).start()).rejects.toThrow(/bind failed/);
    expect(process.umask()).toBe(mask);
    expect(fs.readdirSync(dir)).toEqual([]);
  });

  it("does not hold restrictive umask while waiting for listen callback", async () => {
    const { sock } = paths();
    const mask = process.umask();
    const listen = net.Server.prototype.listen;
    let callback!: () => void;
    vi.spyOn(net.Server.prototype, "listen").mockImplementation(function (
      this: Server,
      ...args: unknown[]
    ) {
      callback = args.pop() as () => void;
      return Reflect.apply(listen, this, args);
    });
    const e = endpoint(sock);
    const starting = e.start();
    await vi.waitFor(() => expect(callback).toBeDefined());
    expect(process.umask()).toBe(mask);
    callback();
    await starting;
  });

  it("rolls back a bound private listener if chmod fails", async () => {
    const { sock, dir } = paths();
    vi.spyOn(fs, "chmodSync").mockImplementation(() => {
      throw new Error("chmod denied");
    });
    await expect(endpoint(sock).start()).rejects.toThrow(/chmod denied/);
    expect(fs.readdirSync(dir)).toEqual([]);
  });

  it("preserves PID contents changed in place despite matching inode", async () => {
    const { sock, pid } = paths();
    const e = endpoint(sock, pid);
    await e.start();
    fs.writeFileSync(pid, "2147483647");
    await e.stop();
    expect(fs.readFileSync(pid, "utf8")).toBe("2147483647");
  });

  it("bounds colliding bind retries without unlinking the colliding listener", async () => {
    const { sock, dir } = paths();
    const collision = join(dir, ".sCOLLIDE1");
    await raw(collision);
    const identity = fs.statSync(collision).ino;
    const listen = net.Server.prototype.listen;
    let attempts = 0;
    vi.spyOn(net.Server.prototype, "listen").mockImplementation(function (
      this: Server,
      ...args: unknown[]
    ) {
      attempts++;
      return Reflect.apply(listen, this, [collision, args.at(-1)]);
    });
    await expect(endpoint(sock).start()).rejects.toThrow(/eight|in use/);
    expect(attempts).toBe(8);
    expect(fs.statSync(collision).ino).toBe(identity);
    await connect(collision);
    expect(fs.readdirSync(dir)).toEqual([".sCOLLIDE1"]);
  });

  it("fails closed on a timed-out probe and destroys the probe socket", async () => {
    const { sock } = paths();
    await raw(sock);
    const identity = fs.statSync(sock).ino;
    let probe!: Socket;
    vi.spyOn(net.Socket.prototype, "connect").mockImplementation(function (this: Socket) {
      probe = this;
      return this;
    });
    vi.useFakeTimers();
    const starting = endpoint(sock).start();
    const rejected = expect(starting).rejects.toThrow(/timed out/);
    await vi.advanceTimersByTimeAsync(1_000);
    await rejected;
    expect(probe.destroyed).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
    expect(fs.statSync(sock).ino).toBe(identity);
  });

  it("fails closed on probe permission errors", async () => {
    const { sock } = paths();
    await raw(sock);
    const identity = fs.statSync(sock).ino;
    let probe!: Socket;
    vi.spyOn(net.Socket.prototype, "connect").mockImplementation(function (this: Socket) {
      probe = this;
      return this;
    });
    const starting = endpoint(sock).start();
    const rejected = expect(starting).rejects.toThrow(/denied/);
    await Promise.resolve();
    probe.emit("error", Object.assign(new Error("denied"), { code: "EACCES" }));
    await rejected;
    expect(probe.destroyed).toBe(true);
    expect(fs.statSync(sock).ino).toBe(identity);
  });

  it("rejects paths beyond the platform socket byte limit before truncation", async () => {
    const { dir } = paths();
    const sock = join(dir, "x".repeat(108));
    await expect(endpoint(sock).start()).rejects.toThrow(/long|length/);
    expect(fs.readdirSync(dir)).toEqual([]);
  });

  it("two independent starters have one winner whose endpoint remains reachable", async () => {
    const { sock, pid } = paths();
    const a = await child();
    const b = await child();
    const results = await Promise.all([startChild(a, sock, pid), startChild(b, sock, pid)]);
    expect(results.filter((r) => r.ready)).toHaveLength(1);
    expect(results.filter((r) => /busy|running|in use/.test(r.error ?? ""))).toHaveLength(1);
    await connect(sock);
  });
});
