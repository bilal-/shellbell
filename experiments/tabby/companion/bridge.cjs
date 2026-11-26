const net = require("node:net");
const { randomUUID } = require("node:crypto");
const { channel, paths, readKey, proof, matches, VERSION } = require("./wire.cjs");
const { capture } = require("./screen.cjs");

/** Tabby's own reader for a process's folder, when its renderer can load it. */
let folderOf;
try {
  folderOf = require("native-process-working-directory").getWorkingDirectoryFromPID;
} catch {
  folderOf = undefined;
}

/** Leaves room in the bridge's 550,000-byte frame for the reply around a screen. */
const FRAME_BUDGET = 540000;

// One renderer owns one bridge. Its window and pane IDs outlive bridge reconnects, so a
// restarted service finds the same panes; a pane's ID changes only with its session.
class WindowBridge {
  windowId = randomUUID();
  panes = new Map();
  watched = new Set();
  tabIds = new WeakMap();
  attach(tab) {
    if (this.panes.has(tab) || this.panes.size >= 128) return;
    const p = { tab, subscriptions: [], revision: 0 };
    this.panes.set(tab, p);
    const updateSession = () => {
      this.watched.delete(p.id);
      p.closed?.unsubscribe();
      p.session = tab.session;
      p.closed = p.session?.closed$.subscribe(() => this.inventorySoon());
      p.id = randomUUID();
      p.pid = p.cwd = undefined;
      p.oversized = undefined;
      this.refreshProcess(p);
      this.inventorySoon();
    };
    const changed = () => {
      p.revision++;
      const alt = tab.frontend?.xterm?.buffer.active.type === "alternate";
      if (p.alternate !== alt || p.open !== tab.session?.open) {
        p.alternate = alt;
        p.open = tab.session?.open;
        this.inventorySoon();
      }
      if (!this.watched.has(p.id) || p.timer) return;
      p.timer = setTimeout(() => {
        p.timer = null;
        if (this.watched.has(p.id)) this.notify({ op: "dirty", id: p.id });
      }, 60);
    };
    updateSession();
    p.subscriptions.push(
      tab.sessionChanged$.subscribe(updateSession),
      tab.titleChange$.subscribe(() => this.inventorySoon()),
      tab.resize$.subscribe(() => {
        changed();
        this.inventorySoon();
      }),
      tab.focused$.subscribe(() => this.inventorySoon()),
      tab.blurred$.subscribe(() => this.inventorySoon()),
      tab.frontend.xterm.onWriteParsed(changed),
    );
    if (!this.socket && !this.retry) this.connect();
  }
  detach(tab) {
    const p = this.panes.get(tab);
    if (!p) return;
    this.panes.delete(tab);
    this.watched.delete(p.id);
    p.closed?.unsubscribe();
    clearTimeout(p.timer);
    for (const s of p.subscriptions) s.dispose ? s.dispose() : s.unsubscribe();
    this.inventorySoon();
  }
  inventorySoon() {
    if (this.refresh) return;
    this.refresh = setTimeout(() => {
      this.refresh = null;
      this.inventory();
    }, 25);
  }
  inventory() {
    if (!this.send) return;
    const panes = [];
    for (const p of this.panes.values()) {
      if (!p.session || p.session !== p.tab.session || !p.session.open) continue;
      const term = p.tab.frontend?.xterm;
      // A hidden or closing pane can briefly have no terminal or size; one such pane must not
      // break the whole window's inventory.
      if (!term || !(term.cols > 0) || !(term.rows > 0)) continue;
      const parent = p.tab.topmostParent || p.tab;
      if (!this.tabIds.has(parent)) this.tabIds.set(parent, randomUUID());
      panes.push({
        id: p.id,
        group: this.tabIds.get(parent),
        tabIndex: Math.max(0, p.tab.app.tabs.indexOf(parent)),
        paneIndex: Math.max(0, parent.getAllTabs?.().indexOf(p.tab) ?? 0),
        title: String(p.tab.displayTitle || p.tab.title || "Tabby").slice(0, 256),
        cols: term.cols,
        rows: term.rows,
        focused: !!p.tab.hasFocus,
        alternate: term.buffer.active.type === "alternate",
        pid: p.pid,
        cwd: p.cwd,
      });
    }
    this.notify({ op: "inventory", window: this.windowId, panes });
  }
  // The shell's process and folder name the pane; a change sends a fresh inventory. The
  // shell starts after its session, so its PID is read again until it is known.
  refreshProcess(p) {
    const session = p.session;
    // A read still running for an earlier session does not hold up the new one.
    if (p.reading === session || !session?.pty) return;
    p.reading = session;
    const pty = session.pty;
    // Each read runs inside a promise, so a disposed PTY that throws at once cannot wedge it.
    const read = (method) =>
      Promise.resolve()
        .then(() => pty[method]?.())
        .catch(() => undefined);
    read("getPID")
      .catch(() => undefined)
      .then(async (pid) => {
        const shell = Number.isSafeInteger(pid) && pid > 0 ? pid : undefined;
        if (shell === undefined) return [undefined, undefined];
        // The shell's own folder. Tabby's session API may instead read a process it picked when
        // the shell started, such as a prompt helper, so use that only when it is the shell.
        if (folderOf) {
          try {
            return [shell, folderOf(shell)];
          } catch {
            return [shell, undefined];
          }
        }
        const truePid = await read("getTruePID");
        if (truePid !== shell) return [shell, undefined];
        return [shell, await read("getWorkingDirectory")];
      })
      .then(([shell, cwd]) => {
        if (p.session !== session) return;
        const folder =
          typeof cwd === "string" && cwd.startsWith("/") && cwd.length <= 1024 ? cwd : undefined;
        if (shell === p.pid && folder === p.cwd) return;
        p.pid = shell;
        p.cwd = folder;
        this.inventorySoon();
      })
      .finally(() => {
        if (p.reading === session) p.reading = undefined;
      });
  }

  notify(message) {
    try {
      this.send?.(message);
    } catch {
      this.socket?.destroy();
    }
  }
  retryLater() {
    if (!this.panes.size) return;
    this.retry = setTimeout(() => {
      this.retry = null;
      this.connect();
    }, 1000);
  }
  connect() {
    let config, key;
    try {
      config = paths();
      key = readKey(config.key);
    } catch {
      this.retryLater();
      return;
    }
    const socket = net.createConnection(config.socket);
    this.socket = socket;
    const client = randomUUID();
    let server,
      sequence = 0;
    const deadline = setTimeout(() => socket.destroy(), 3000);
    const send = channel(socket, (msg) => {
      if (!server) {
        if (msg.op !== "challenge" || typeof msg.server !== "string" || msg.server.length !== 36)
          throw Error();
        server = msg.server;
        send({
          op: "proof",
          version: VERSION,
          client,
          mac: proof(key, "window", server, client, VERSION),
        });
        return;
      }
      if (!this.send) {
        if (msg.op !== "ready" || !matches(proof(key, "agent", server, client, VERSION), msg.mac))
          throw Error();
        clearTimeout(deadline);
        this.send = send;
        // A plain `cd` or a late shell start changes no title, so check panes periodically.
        this.poll = setInterval(() => {
          for (const p of this.panes.values()) this.refreshProcess(p);
        }, 3000);
        this.inventory();
        return;
      }
      if (msg.op === "watch" && Array.isArray(msg.ids) && msg.ids.length <= 128) {
        this.watched = new Set(msg.ids);
        return;
      }
      if (!Number.isSafeInteger(msg.seq) || msg.seq !== sequence + 1) throw Error();
      sequence = msg.seq;
      const p = [...this.panes.values()].find((p) => p.id === msg.id);
      if (!p?.session?.open || p.tab.session !== p.session) {
        send({ op: "reply", seq: sequence, ok: false });
        return;
      }
      if (msg.op === "input" && typeof msg.data === "string" && msg.data.length <= 65536) {
        p.tab.sendInput(msg.data);
        send({ op: "reply", seq: sequence, ok: true });
      } else if (msg.op === "screen") {
        let screen;
        try {
          // An oversized screen is not captured again until the pane changes.
          if (p.oversized !== p.revision) screen = capture(p.tab.frontend.xterm);
        } catch {
          /* refused geometry */
        }
        // A screen too large for one frame fails alone instead of closing the window's bridge.
        if (screen && Buffer.byteLength(JSON.stringify(screen)) > FRAME_BUDGET) {
          screen = undefined;
          p.oversized = p.revision;
        }
        send({
          op: "reply",
          seq: sequence,
          ok: !!screen,
          revision: p.revision,
          screen,
        });
      } else throw Error();
    });
    socket.once("close", () => {
      clearTimeout(deadline);
      clearInterval(this.poll);
      this.socket = this.send = null;
      this.watched.clear();
      this.retryLater();
    });
  }
}
module.exports = { WindowBridge };
