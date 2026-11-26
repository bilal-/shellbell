import { execFile } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import fs from "node:fs";
import { createRequire } from "node:module";
import net from "node:net";
import path from "node:path";
import wire from "./companion/wire.cjs";

const uuid = /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/;
const native = createRequire(import.meta.url)("./peer.node");

/** Each process's terminal foreground group and executable, read at most once a second. */
let processTable = { at: 0, rows: new Map() };
let reading;
function processes() {
  if (Date.now() - processTable.at < 1000) return Promise.resolve(processTable.rows);
  reading ??= new Promise((resolve) => {
    execFile(
      "ps",
      // -ww: without a terminal, as under launchd, BSD ps cuts each line at 79 columns.
      ["-A", "-ww", "-o", "pid=,pgid=,tpgid=,comm="],
      { timeout: 2000, maxBuffer: 4 << 20 },
      (error, stdout) => {
        // A failed read keeps the last table rather than clearing every pane's program.
        const rows = error ? processTable.rows : new Map();
        if (!error)
          for (const line of stdout.split("\n")) {
            const m = /^\s*(\d+)\s+(\d+)\s+(-?\d+)\s+(.+)$/.exec(line);
            if (m)
              rows.set(Number(m[1]), {
                processGroup: Number(m[2]),
                group: Number(m[3]),
                command: path
                  .basename(m[4].trim())
                  .replace(/\p{Cc}/gu, "")
                  .slice(0, 128),
              });
          }
        processTable = { at: Date.now(), rows };
        reading = undefined;
        resolve(rows);
      },
    );
  });
  return reading;
}
/**
 * The program in front of a pane's shell: its terminal's foreground group leader or, once the
 * leader of a pipeline has exited, the group's one remaining program.
 */
function foregroundOf(table, shellPid) {
  const group = shellPid && table.get(shellPid)?.group;
  if (!(group > 0)) return undefined;
  const leader = table.get(group);
  if (leader) return leader.command;
  const names = new Set();
  for (const row of table.values()) if (row.processGroup === group) names.add(row.command);
  return names.size === 1 ? [...names][0] : undefined;
}
/** Foreground programs that leave the shell's folder on this computer. */
const LOCAL = new Set([
  "zsh",
  "bash",
  "fish",
  "sh",
  "dash",
  "ksh",
  "tcsh",
  "nu",
  "claude",
  "codex",
  "agy",
  "gemini",
  "node",
]);
/** Pane identities and arrangement, without the titles and folders that change often. */
function layoutOf(panes) {
  return JSON.stringify(
    [...panes.values()].map((p) => [
      p.id,
      p.group,
      p.tabIndex,
      p.paneIndex,
      p.cols,
      p.rows,
      !!p.focused,
      !!p.alternate,
    ]),
  );
}
/** How long a window may stay away before its panes are reported closed. */
const RECONNECT_MS = 5000;

const capabilities = {
  subscribe: true,
  prompts: false,
  createSession: false,
  focus: false,
  history: false,
  absoluteLines: false,
  terminalInput: true,
};

export class TabbyBackend {
  constructor({ deliveryUnknown, log }) {
    if (typeof deliveryUnknown !== "function")
      throw Error("Update the Shellbell agent before connecting Tabby");
    this.deliveryUnknown = deliveryUnknown;
    this.log = log;
  }
  name = "tabby";
  capabilities = capabilities;
  windows = new Set();
  accepted = 0;
  /** Windows whose connection closed: their panes and connection order, until they return. */
  departed = new Map();
  /** The newest connection order each known window has used. */
  owners = new Map();
  listeners = new Set();
  watched = new Set();
  get isConnected() {
    return [...this.windows].some((w) => w.panes);
  }
  on(fn) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }
  emit(event) {
    for (const fn of this.listeners) fn(event);
  }
  async connect() {
    if (this.server) return;
    this.closing = false;
    const config = wire.paths();
    const lock = fs.openSync(
      path.join(config.root, "lock"),
      fs.constants.O_RDWR | fs.constants.O_CREAT | fs.constants.O_NOFOLLOW,
      0o600,
    );
    if (!native.lock(lock)) {
      fs.closeSync(lock);
      throw Error("Another adapter owns this directory");
    }
    this.lock = lock;
    try {
      try {
        fs.writeFileSync(config.key, randomBytes(32), {
          flag: "wx",
          mode: 0o600,
        });
      } catch (e) {
        if (e.code !== "EEXIST") throw e;
      }
      const key = wire.readKey(config.key);
      try {
        const s = fs.lstatSync(config.socket);
        if (!s.isSocket() || s.uid !== process.getuid()) throw Error("Unexpected socket path");
        fs.unlinkSync(config.socket);
      } catch (e) {
        if (e.code !== "ENOENT") throw e;
      }
      this.poll = setInterval(() => void this.checkForeground(), 2000);
      this.poll.unref?.();
      this.server = net.createServer((socket) => this.accept(socket, key));
      this.server.maxConnections = 12;
      const server = this.server;
      await new Promise((resolve, reject) => {
        server.once("error", reject);
        server.listen(config.socket, resolve);
      });
      // An error after listening must not escape as an uncaught exception in the service.
      server.on("error", () => this.log.warn("Tabby bridge listener failed"));
      if (this.closing || this.server !== server) {
        server.close();
        return;
      }
    } catch (e) {
      await this.close();
      throw e;
    }
  }
  accept(socket, key) {
    // A connection that resets before this runs has no descriptor; any failure here must close
    // only that socket, never throw into the service.
    try {
      this.admit(socket, key);
    } catch {
      socket.destroy();
    }
  }
  admit(socket, key) {
    const fd = socket._handle?.fd;
    if (!Number.isSafeInteger(fd) || fd < 0 || !native.sameUser(fd)) {
      socket.destroy();
      return;
    }
    const epoch = randomUUID();
    const w = {
      epoch,
      order: ++this.accepted,
      socket,
      pending: new Map(),
      sequence: 0,
      authenticated: false,
    };
    this.windows.add(w);
    const deadline = setTimeout(() => socket.destroy(), 3000);
    w.send = wire.channel(socket, (msg) => {
      if (!w.authenticated) {
        if (
          msg.op !== "proof" ||
          !uuid.test(msg.client) ||
          !wire.matches(wire.proof(key, "window", epoch, msg.client, msg.version), msg.mac)
        )
          throw Error();
        if (msg.version !== wire.VERSION) {
          if (!this.versionMismatch)
            this.log.warn("Reopen Tabby after updating its Shellbell plugin.");
          this.versionMismatch = true;
          throw Error();
        }
        w.authenticated = true;
        w.send({
          op: "ready",
          mac: wire.proof(key, "agent", epoch, msg.client, wire.VERSION),
        });
        return;
      }
      if (msg.op === "inventory") {
        if (!uuid.test(msg.window) || (w.id && w.id !== msg.window)) throw Error();
        if (!Array.isArray(msg.panes) || msg.panes.length > 128) throw Error();
        const panes = new Map();
        for (const p of msg.panes) {
          if (
            !uuid.test(p.id) ||
            !uuid.test(p.group) ||
            ![p.tabIndex, p.paneIndex].every((n) => Number.isSafeInteger(n) && n >= 0) ||
            panes.has(p.id) ||
            typeof p.title !== "string" ||
            p.title.length > 256 ||
            (p.pid !== undefined && !(Number.isSafeInteger(p.pid) && p.pid > 0)) ||
            (p.cwd !== undefined &&
              (typeof p.cwd !== "string" || !p.cwd.startsWith("/") || p.cwd.length > 1024)) ||
            ![p.cols, p.rows].every((n) => Number.isSafeInteger(n) && n > 0 && n <= 4096)
          )
            throw Error();
          panes.set(p.id, p);
        }
        if (
          [...this.windows].reduce(
            (n, other) => n + (other === w || other.id === msg.window ? 0 : other.panes?.size || 0),
            panes.size,
          ) > 500
        )
          throw Error();
        // A reconnecting window replaces its earlier connection; an older one never wins, even
        // after the newer one has itself gone away.
        if ((this.owners.get(msg.window) ?? 0) > w.order) throw Error();
        this.owners.set(msg.window, w.order);
        let previous = w.panes;
        const structure = previous && layoutOf(previous);
        const away = this.departed.get(msg.window);
        if (away) {
          clearTimeout(away.timer);
          this.departed.delete(msg.window);
          previous ??= away.panes;
        }
        w.id = msg.window;
        w.panes = panes;
        clearTimeout(deadline);
        this.versionMismatch = false;
        // Install the replacement before retiring the old connection, so Tabby never looks
        // disconnected in between.
        for (const other of [...this.windows])
          if (other !== w && other.id === msg.window) {
            previous ??= other.panes;
            this.retire(other, true);
          }
        for (const id of previous?.keys() || [])
          if (!panes.has(id)) this.emit({ type: "session-removed", sessionId: `${w.id}/${id}` });
        this.sendWatch(w);
        // Titles, folders and processes change often, as when an agent animates its title. Only a
        // change of panes, tabs, sizes or focus is a layout change.
        if (structure !== undefined && structure === layoutOf(panes)) {
          for (const [id, pane] of panes) {
            const before = previous.get(id);
            if (before.title !== pane.title || before.cwd !== pane.cwd || before.pid !== pane.pid)
              this.emit({ type: "title-changed", sessionId: `${w.id}/${id}` });
          }
        } else this.emit({ type: "layout-changed" });
      } else if (msg.op === "dirty" && w.panes?.has(msg.id)) {
        const sessionId = `${w.id}/${msg.id}`;
        if (this.watched.has(sessionId)) this.emit({ type: "screen-changed", sessionId });
      } else if (msg.op === "reply") {
        const pending = w.pending.get(msg.seq);
        if (!pending) throw Error();
        pending.finish(msg);
      } else if (msg.op !== "dirty") throw Error();
    });
    socket.once("close", () => {
      clearTimeout(deadline);
      if (this.windows.has(w)) this.retire(w);
    });
    w.send({ op: "challenge", server: epoch });
  }
  async listSessions() {
    const table = await processes();
    const foreground = new Map();
    const sessions = [...this.windows]
      .filter((w) => w.panes?.size)
      .flatMap((w, i) =>
        [...(w.panes?.values() || [])].map((p) => {
          const id = `${w.id}/${p.id}`;
          const command = foregroundOf(table, p.pid);
          if (command) foreground.set(id, command);
          return {
            id,
            backend: "tabby",
            title: p.title,
            ...(p.cwd ? { cwd: p.cwd } : {}),
            cols: p.cols,
            rows: p.rows,
            windowId: w.id,
            windowNumber: i + 1,
            tabId: `${w.id}/${p.group}`,
            tabIndex: p.tabIndex,
            paneIndex: p.paneIndex,
            isFocusedOnMac: !!p.focused,
            alternateScreen: !!p.alternate,
            state: "unknown",
          };
        }),
      );
    this.foreground = foreground;
    return sessions;
  }
  // Starting or leaving an agent often changes no title, so watch each pane's foreground.
  async checkForeground() {
    if (!this.foreground || !this.isConnected) return;
    const table = await processes();
    for (const w of this.windows)
      for (const p of w.panes?.values() || []) {
        if (foregroundOf(table, p.pid) !== this.foreground.get(`${w.id}/${p.id}`)) {
          this.emit({ type: "layout-changed" });
          return;
        }
      }
  }
  /** The pane's foreground program, which names its agent and hides a hosted tmux or Herdr. */
  hostedProcess(id) {
    return this.foreground?.get(id);
  }
  /** The shell's own folder, read from its process, while a local program is in front. */
  projectFolder(id) {
    const [windowId, paneId] = id.split("/");
    const w = [...this.windows].find((w) => w.id === windowId);
    const pane = w?.panes?.get(paneId);
    return pane?.cwd && LOCAL.has(this.foreground?.get(id)) ? pane.cwd : undefined;
  }
  /**
   * Removes a connection at once, so its panes are never listed twice or sent input. A window
   * that went away is remembered briefly: a reconnect then reports the panes it no longer has,
   * and one that never returns has all its panes reported closed.
   */
  retire(w, replaced = false) {
    if (!this.windows.delete(w)) return;
    for (const pending of w.pending.values()) pending.finish(null);
    w.socket.destroy();
    if (!replaced && w.id && w.panes && !this.closing) {
      const earlier = this.departed.get(w.id);
      if (!earlier || earlier.order < w.order) {
        clearTimeout(earlier?.timer);
        const away = { order: w.order, panes: w.panes };
        away.timer = setTimeout(() => {
          if (this.departed.get(w.id) !== away) return;
          this.departed.delete(w.id);
          if (this.owners.get(w.id) === w.order) this.owners.delete(w.id);
          for (const pane of away.panes.keys())
            this.emit({ type: "session-removed", sessionId: `${w.id}/${pane}` });
        }, RECONNECT_MS);
        away.timer.unref?.();
        this.departed.set(w.id, away);
      }
    }
    if (!replaced) this.emit({ type: "layout-changed" });
  }
  setWatched(ids) {
    this.watched = new Set(ids);
    for (const w of this.windows) if (w.panes) this.sendWatch(w);
  }
  /**
   * Tells a window which of its panes phones are viewing, whenever that set changes. A pane that
   * joins the set, as on a reconnected window, is redrawn to show output missed meanwhile.
   */
  sendWatch(w) {
    const ids = [...w.panes.keys()].filter((id) => this.watched.has(`${w.id}/${id}`));
    const key = ids.join(",");
    if (key === w.watchKey) return;
    const before = new Set(w.watchKey ? w.watchKey.split(",") : []);
    try {
      w.send({ op: "watch", ids });
    } catch {
      this.retire(w);
      return;
    }
    w.watchKey = key;
    for (const id of ids)
      if (!before.has(id)) this.emit({ type: "screen-changed", sessionId: `${w.id}/${id}` });
  }
  async request(target, op, data) {
    const [windowId, id] = target.split("/");
    const w = [...this.windows].find((w) => w.id && w.id === windowId);
    if (!w?.panes?.has(id) || target !== `${windowId}/${id}`) throw Error("Tabby pane closed");
    if (w.pending.size >= 4) throw Error("Tabby window busy");
    const seq = ++w.sequence;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => w.socket.destroy(), 2500);
      const finish = (msg) => {
        clearTimeout(timer);
        w.pending.delete(seq);
        if (msg?.ok === true && (op === "input" || w.panes?.has(id))) resolve(msg);
        else if (!msg && op === "input") reject(this.deliveryUnknown());
        else reject(Error("Tabby request unavailable"));
      };
      w.pending.set(seq, { finish });
      try {
        w.send({ op, id, seq, data });
      } catch {
        // Nothing was written, so this input was certainly not delivered.
        clearTimeout(timer);
        w.pending.delete(seq);
        reject(Error("Tabby window unavailable"));
        this.retire(w);
      }
    });
  }
  async getScreen(id) {
    return (await this.request(id, "screen")).screen;
  }
  async sendInput(id, text) {
    await this.request(id, "input", text);
  }
  async sendText(id, text) {
    await this.sendInput(id, text);
  }
  async getHistory() {
    return { lines: [], oldestAvailable: 0 };
  }
  async createSession() {
    throw Error("Session creation unsupported");
  }
  async focus() {
    throw Error("Focus unsupported");
  }
  async close() {
    this.closing = true;
    clearInterval(this.poll);
    for (const away of this.departed.values()) clearTimeout(away.timer);
    this.departed.clear();
    this.owners.clear();
    for (const w of this.windows) w.socket.destroy();
    const server = this.server;
    this.server = undefined;
    if (server?.listening) await new Promise((resolve) => server.close(resolve));
    if (this.lock !== undefined) fs.closeSync(this.lock);
    this.lock = undefined;
  }
}
export default {
  apiVersion: 1,
  id: "tabby",
  label: "Tabby",
  platforms: ["darwin", "linux"],
  create: (context) => new TabbyBackend(context),
};
