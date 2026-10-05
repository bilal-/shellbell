import { randomBytes } from "node:crypto";
import fs, { type Stats } from "node:fs";
import { createConnection, createServer, type Server, type Socket } from "node:net";
import { dirname, join } from "node:path";
import { writeSecretFile } from "./config.js";
import { acquireControlGuard, processAlive, validPid } from "./control-guard.js";
import { type Logger, safeErrorName } from "./log.js";

function stat(path: string): Stats | undefined {
  try {
    return fs.lstatSync(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}
function same(a: Stats | undefined, b: Stats): boolean {
  return a?.dev === b.dev && a.ino === b.ino;
}
function checkLength(path: string): void {
  const limit = process.platform === "darwin" ? 103 : process.platform === "linux" ? 107 : null;
  if (limit === null) throw new Error(`Unsupported control socket platform: ${process.platform}`);
  if (Buffer.byteLength(path) > limit)
    throw new Error(`Control socket path is too long (maximum ${limit} bytes): ${path}`);
}
async function listening(path: string): Promise<boolean> {
  return new Promise((resolve, reject) => {
    const socket = createConnection(path);
    const timer = setTimeout(
      () => finish(new Error(`Control socket probe timed out: ${path}`)),
      1_000,
    );
    const finish = (error?: Error, alive = false) => {
      clearTimeout(timer);
      socket.destroy();
      if (error) reject(error);
      else resolve(alive);
    };
    socket.once("connect", () => finish(undefined, true));
    socket.once("error", (error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT" || error.code === "ECONNREFUSED") finish();
      else finish(error);
    });
  });
}

/** Owns the transport independently of control message dispatch. The private
 * bind path lets libuv close its listener without unlinking a replacement at
 * the public path. Shared cleanup is serialized and identity checked. */
export class ControlEndpoint {
  private server: Server | undefined;
  private clients = new Set<Socket>();
  private ownedSocket: Stats | undefined;
  private ownedPid: { identity: Stats; contents: string } | undefined;
  private lifecycle: Promise<void> = Promise.resolve();

  constructor(
    private readonly sockPath: string,
    private readonly onConnection: (socket: Socket) => void,
    private readonly log: Logger,
    private readonly pidPath?: string,
    private readonly admit?: () => void,
  ) {}

  private serialize(operation: () => Promise<void>): Promise<void> {
    const result = this.lifecycle.then(operation);
    this.lifecycle = result.catch(() => {});
    return result;
  }

  start(): Promise<void> {
    return this.serialize(async () => {
      if (this.server) return;
      if (this.ownedSocket || this.ownedPid)
        throw new Error("Control endpoint cleanup pending; stop it before restarting");
      checkLength(this.sockPath);
      checkLength(join(dirname(this.sockPath), ".s12345678"));
      const release = acquireControlGuard(this.sockPath);
      try {
        this.admit?.();
        this.checkPid();
        const oldSocket = stat(this.sockPath);
        if (oldSocket) {
          if (!oldSocket.isSocket())
            throw new Error(`Control socket path is not a socket: ${this.sockPath}`);
          if (await listening(this.sockPath))
            throw new Error(`Control endpoint already running: ${this.sockPath}`);
          if (!same(stat(this.sockPath), oldSocket))
            throw new Error("Control socket changed during startup; retry");
          fs.unlinkSync(this.sockPath);
          for (const name of fs.readdirSync(dirname(this.sockPath))) {
            if (!/^\.s[A-Za-z0-9_-]{8}$/.test(name)) continue;
            const path = join(dirname(this.sockPath), name);
            if (same(stat(path), oldSocket)) fs.unlinkSync(path);
          }
        }
        const privatePath = await this.bind();
        fs.chmodSync(privatePath, 0o600);
        const identity = fs.lstatSync(privatePath);
        fs.linkSync(privatePath, this.sockPath);
        this.ownedSocket = identity;
        if (this.pidPath) {
          // Recheck after asynchronous probing/binding; cooperating writers also
          // hold the guard, while unknown live/invalid PID files fail closed.
          this.checkPid();
          const contents = String(process.pid);
          writeSecretFile(this.pidPath, contents);
          this.ownedPid = { identity: fs.lstatSync(this.pidPath), contents };
        }
        // Binding awaited the event loop. Revalidate the owner only after the
        // endpoint/PID are published, still under the endpoint guard, before
        // returning admission to the caller that will start remote access.
        this.admit?.();
      } catch (error) {
        try {
          this.removeOwned();
        } finally {
          await this.closeListener();
        }
        throw error;
      } finally {
        release();
      }
    });
  }

  private checkPid(): void {
    if (!this.pidPath) return;
    const identity = stat(this.pidPath);
    if (!identity) return;
    if (!identity.isFile()) throw new Error(`PID path must be a regular file: ${this.pidPath}`);
    const pid = validPid(fs.readFileSync(this.pidPath, "utf8").trim());
    if (pid === null) throw new Error(`Invalid PID file; inspect ${this.pidPath} before retrying`);
    if (processAlive(pid)) throw new Error(`shellbell is already running (pid ${pid})`);
  }

  private async bind(): Promise<string> {
    for (let attempt = 0; attempt < 8; attempt++) {
      const path = join(dirname(this.sockPath), `.s${randomBytes(6).toString("base64url")}`);
      const server = createServer((socket) => {
        this.clients.add(socket);
        socket.once("close", () => this.clients.delete(socket));
        socket.on("error", () => {});
        this.onConnection(socket);
      });
      this.server = server;
      try {
        await new Promise<void>((resolve, reject) => {
          server.once("error", reject);
          // listen creates the pathname synchronously; do not hold a process-wide
          // umask across an await or an asynchronous listen callback.
          const previous = process.umask(0o177);
          try {
            server.listen(path, () => {
              server.removeListener("error", reject);
              resolve();
            });
          } finally {
            process.umask(previous);
          }
        });
        return path;
      } catch (error) {
        await this.closeListener();
        if ((error as NodeJS.ErrnoException).code !== "EADDRINUSE") throw error;
      }
    }
    throw new Error("Control endpoint private socket names are in use after eight attempts");
  }

  private removeOwned(): void {
    if (this.ownedSocket) {
      if (same(stat(this.sockPath), this.ownedSocket)) fs.unlinkSync(this.sockPath);
      this.ownedSocket = undefined;
    }
    if (this.pidPath && this.ownedPid) {
      const current = stat(this.pidPath);
      if (
        current?.isFile() &&
        same(current, this.ownedPid.identity) &&
        fs.readFileSync(this.pidPath, "utf8") === this.ownedPid.contents
      )
        fs.unlinkSync(this.pidPath);
      this.ownedPid = undefined;
    }
  }

  private async closeListener(): Promise<void> {
    for (const socket of this.clients) socket.destroy();
    this.clients.clear();
    const server = this.server;
    this.server = undefined;
    if (server)
      await new Promise<void>((resolve, reject) =>
        server.close((error?: Error) => {
          if (error && (error as NodeJS.ErrnoException).code !== "ERR_SERVER_NOT_RUNNING")
            reject(error);
          else resolve();
        }),
      );
  }

  stop(): Promise<void> {
    return this.serialize(async () => {
      let release: (() => void) | undefined;
      try {
        if (this.ownedSocket || this.ownedPid) {
          release = acquireControlGuard(this.sockPath);
          this.removeOwned();
        }
      } catch (error) {
        this.log.warn("Control endpoint cleanup failed; shared paths retained for retry", {
          error: safeErrorName(error),
        });
        throw error;
      } finally {
        try {
          await this.closeListener();
        } finally {
          release?.();
        }
      }
    });
  }
}
