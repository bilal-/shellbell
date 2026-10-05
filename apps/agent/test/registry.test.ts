import { describe, expect, it, vi } from "vitest";
import { BackendRegistry, prefixId, splitId } from "../src/backends/registry.js";
import { createLogger } from "../src/log.js";
import { FakeBackend } from "./fakes/fake-backend.js";

describe("BackendRegistry", () => {
  it("does not deliver an in-progress event to a reentrant replacement listener", () => {
    const reg = new BackendRegistry(createLogger({ stdout: false }));
    const backend = new FakeBackend();
    reg.add(backend);
    const seen: string[] = [];
    let remove: () => void = () => {};
    remove = reg.on(() => {
      seen.push("old");
      remove();
      reg.on(() => seen.push("new"));
    });
    backend.emit({ type: "session-removed", sessionId: "S" });
    expect(seen).toEqual(["old"]);
    backend.emit({ type: "session-removed", sessionId: "S" });
    expect(seen).toEqual(["old", "new"]);
  });
  it("prefixes ids, routes calls, merges events, hides tmux panes iTerm2 already shows", async () => {
    const reg = new BackendRegistry(createLogger({ stdout: false }));
    const iterm = new FakeBackend();
    iterm.addSession("A", {});
    iterm.tmuxWindowIds = () => new Set(["@1"]);
    const tmux = new FakeBackend("tmux");
    tmux.addSession("%1", {});
    tmux.addSession("%2", {});
    tmux.tmuxWindowIdOf = (id: string) => (id === "%1" ? "@1" : "@2");
    reg.add(iterm);
    reg.add(tmux);
    const ids = (await reg.listSessions()).map((s) => s.id);
    expect(ids).toEqual(["iterm2:A", "tmux:%2"]);
    const events: string[] = [];
    reg.on((e) => events.push("sessionId" in e ? e.sessionId : e.type));
    tmux.emit({ type: "screen-changed", sessionId: "%2" });
    expect(events).toEqual(["tmux:%2"]);
    await reg.sendText("tmux:%2", "x");
    expect(tmux.sentText).toEqual([{ id: "%2", text: "x" }]);
    await expect(reg.sendText("kitty:1", "x")).rejects.toThrow(/session gone/);
    expect(await reg.createSession({ kind: "tab", backend: "tmux" })).toMatch(/^tmux:/);
    await expect(
      reg.createSession({ kind: "tab", backend: "tmux", windowId: "iterm2:w1" }),
    ).rejects.toThrow(/bad-window/);
    expect(splitId("tmux:%3")).toEqual({ name: "tmux", native: "%3" });
    expect(prefixId("iterm2", "x")).toBe("iterm2:x");
  });

  it("hides the iTerm2 session hosting a connected herdr/tmux client (spec 8.12)", async () => {
    const reg = new BackendRegistry(createLogger({ stdout: false }));
    const iterm = new FakeBackend();
    iterm.addSession("herdr-host", {});
    iterm.addSession("tmux-host", {});
    iterm.addSession("cc-tab", {});
    iterm.addSession("shell", {});
    iterm.hostJob = (id: string) => {
      if (id === "herdr-host") return "herdr";
      if (id === "tmux-host") return "tmux";
      if (id === "cc-tab") return undefined; // -CC tab: iTerm2 backend itself hides this case
      return "zsh";
    };
    reg.add(iterm);

    // (b) herdr backend absent -> the herdr host session is shown.
    expect((await reg.listSessions()).map((s) => s.id)).toEqual([
      "iterm2:herdr-host",
      "iterm2:tmux-host",
      "iterm2:cc-tab",
      "iterm2:shell",
    ]);

    const herdr = new FakeBackend("herdr");
    reg.add(herdr);
    const tmux = new FakeBackend("tmux");
    reg.add(tmux);

    // (a)/(c) herdr and tmux both connected -> both host sessions hidden; (d) the -CC tab and
    // (e) the plain shell are unaffected.
    expect((await reg.listSessions()).map((s) => s.id)).toEqual(["iterm2:cc-tab", "iterm2:shell"]);

    // (f) a hidden session is still addressable -- hiding is a listing rule, not a routing one.
    expect((await reg.getScreen("iterm2:herdr-host")).rows).toBeGreaterThan(0);

    // (b) herdr's transport goes down -> its host session reappears; tmux's stays hidden.
    herdr.isConnected = false;
    expect((await reg.listSessions()).map((s) => s.id)).toEqual([
      "iterm2:herdr-host",
      "iterm2:cc-tab",
      "iterm2:shell",
    ]);

    // tmux disconnects too -> its host session reappears as well.
    reg.remove("tmux");
    expect((await reg.listSessions()).map((s) => s.id)).toEqual([
      "iterm2:herdr-host",
      "iterm2:tmux-host",
      "iterm2:cc-tab",
      "iterm2:shell",
    ]);
  });

  it("one backend failing does not affect the other (spec 15)", async () => {
    const reg = new BackendRegistry(createLogger({ stdout: false }));
    const iterm = new FakeBackend();
    iterm.addSession("A", {});
    const tmux = new FakeBackend("tmux");
    tmux.addSession("%1", {});
    reg.add(iterm);
    reg.add(tmux);

    // iTerm2 blows up on every call; tmux must keep working.
    iterm.getScreen = async () => {
      throw new Error("iTerm2 API died");
    };
    iterm.sendText = async () => {
      throw new Error("iTerm2 API died");
    };
    await expect(reg.getScreen("iterm2:A")).rejects.toThrow(/iTerm2 API died/);
    await expect(reg.sendText("iterm2:A", "x")).rejects.toThrow(/iTerm2 API died/);
    expect((await reg.getScreen("tmux:%1")).rows).toBeGreaterThan(0);
    await reg.sendText("tmux:%1", "ok");
    expect(tmux.sentText).toEqual([{ id: "%1", text: "ok" }]);

    // Removing the broken backend leaves the healthy one listed and routable.
    reg.remove("iterm2");
    expect((await reg.listSessions()).map((x) => x.id)).toEqual(["tmux:%1"]);
    await expect(reg.getScreen("iterm2:A")).rejects.toThrow(/session gone/);

    // Events from the survivor still reach subscribers.
    const seen: string[] = [];
    reg.on((e) => seen.push("sessionId" in e ? e.sessionId : e.type));
    tmux.emit({ type: "screen-changed", sessionId: "%1" });
    expect(seen).toContain("tmux:%1");
  });

  it("listSessions isolates a failing backend and returns the survivors (spec 8.12/15)", async () => {
    const reg = new BackendRegistry(createLogger({ stdout: false }));
    const iterm = new FakeBackend();
    iterm.addSession("A", {});
    iterm.listSessions = async () => {
      throw new Error("iTerm2 API died");
    };
    const tmux = new FakeBackend("tmux");
    tmux.addSession("%1", {});
    reg.add(iterm);
    reg.add(tmux);

    const sessions = await reg.listSessions();
    expect(sessions.map((s) => s.id)).toEqual(["tmux:%1"]);
  });

  it("reports absoluteLines: false when no backend is connected", () => {
    const reg = new BackendRegistry(createLogger({ stdout: false }));
    expect(reg.capabilities.absoluteLines).toBe(false);
  });

  it("reports every known backend in protocol order without probing transports", () => {
    const reg = new BackendRegistry(createLogger({ stdout: false }));
    const iterm = new FakeBackend();
    const tmux = new FakeBackend("tmux");
    const herdr = new FakeBackend("herdr");
    const itermConnect = vi.spyOn(iterm, "connect");
    const itermList = vi.spyOn(iterm, "listSessions");
    herdr.isConnected = false;
    reg.add(herdr);
    reg.add(iterm);
    reg.add(tmux);

    expect(reg.status()).toEqual([
      { name: "iterm2", connected: true },
      { name: "tmux", connected: true },
      { name: "herdr", connected: false },
    ]);
    expect(itermConnect).not.toHaveBeenCalled();
    expect(itermList).not.toHaveBeenCalled();

    iterm.isConnected = false;
    herdr.isConnected = true;
    expect(reg.status()).toEqual([
      { name: "iterm2", connected: false },
      { name: "tmux", connected: true },
      { name: "herdr", connected: true },
    ]);

    reg.remove("tmux");
    expect(reg.status()).toEqual([
      { name: "iterm2", connected: false },
      { name: "tmux", connected: false },
      { name: "herdr", connected: true },
    ]);
  });

  it("excludes a registered-but-disconnected member from the aggregate capabilities (M-8)", () => {
    const reg = new BackendRegistry(createLogger({ stdout: false }));
    const iterm = new FakeBackend();
    iterm.addSession("A", {});
    reg.add(iterm);
    expect(reg.capabilities.absoluteLines).toBe(true);

    // Mirrors `startHerdrBackend`: registered before `connect()`, unconditionally, on
    // every machine -- including one with no Herdr installed.
    const herdr = new FakeBackend("herdr");
    herdr.capabilities = { ...herdr.capabilities, absoluteLines: false };
    herdr.isConnected = false;
    reg.add(herdr);
    // A Herdr that never connects must not permanently degrade the aggregate for an iTerm2-only
    // view forever.
    expect(reg.capabilities.absoluteLines).toBe(true);

    // Once it genuinely connects, the aggregate reflects it like any other member again.
    herdr.isConnected = true;
    expect(reg.capabilities.absoluteLines).toBe(false);
  });

  it("close() closes every member and clears them from the registry", async () => {
    const reg = new BackendRegistry(createLogger({ stdout: false }));
    const iterm = new FakeBackend();
    iterm.addSession("A", {});
    reg.add(iterm);
    await reg.close();
    expect(reg.connected()).toEqual([]);
    await expect(reg.getScreen("iterm2:A")).rejects.toThrow(/session gone/);
  });

  it("routes herdr ids and fans setWatched out to every member as native ids", async () => {
    const reg = new BackendRegistry(createLogger({ stdout: false }));
    const iterm = new FakeBackend();
    iterm.addSession("A", {});
    const herdr = new FakeBackend("herdr");
    herdr.addSession("term_a", {});
    reg.add(iterm);
    reg.add(herdr);

    expect((await reg.listSessions()).map((s) => s.id)).toEqual(["iterm2:A", "herdr:term_a"]);
    expect(splitId("herdr:term_a")).toEqual({ name: "herdr", native: "term_a" });
    await reg.sendText("herdr:term_a", "x");
    expect(herdr.sentText).toEqual([{ id: "term_a", text: "x" }]);
    expect(reg.capabilitiesOf("herdr:term_a")).toBe(herdr.capabilities);

    reg.setWatched(["herdr:term_a", "iterm2:A", "bogus"]);
    expect(herdr.watched.at(-1)).toEqual(["term_a"]);
    expect(iterm.watched.at(-1)).toEqual(["A"]);
    // A backend with no watchers still gets a call -- that is how it learns to stop polling.
    reg.setWatched([]);
    expect(herdr.watched.at(-1)).toEqual([]);
    expect(iterm.watched.at(-1)).toEqual([]);
  });

  it("hides a disconnected member from connected() but keeps routing to it", async () => {
    const reg = new BackendRegistry(createLogger({ stdout: false }));
    const iterm = new FakeBackend();
    iterm.addSession("A", {});
    const herdr = new FakeBackend("herdr");
    herdr.addSession("term_a", {});
    reg.add(iterm);
    reg.add(herdr);
    expect(reg.connected().map((b) => b.name)).toEqual(["iterm2", "herdr"]);
    // its socket died; it stays registered (it reconnects itself) but the phones
    // must not be told it is available.
    herdr.isConnected = false;
    expect(reg.connected().map((b) => b.name)).toEqual(["iterm2"]);
    expect(reg.capabilitiesOf("herdr:term_a")).toBe(herdr.capabilities);
  });

  it("connected() is ordered by BACKEND_ORDER, not by registration order (Minor, Task 6 review)", async () => {
    const reg = new BackendRegistry(createLogger({ stdout: false }));
    // Mirrors production: `startHerdrBackend` registers synchronously at startup, while iTerm2
    // only joins the registry after its own `await connect()` resolves (cli.ts) -- so herdr is
    // very often the FIRST member added, and `connected()` must not just echo that back.
    const herdr = new FakeBackend("herdr");
    const iterm = new FakeBackend();
    reg.add(herdr);
    reg.add(iterm);
    expect(reg.connected().map((b) => b.name)).toEqual(["iterm2", "herdr"]);
  });

  it("routes setReported to the owning member with the prefix stripped (spec 8.11)", () => {
    const reg = new BackendRegistry(createLogger({ stdout: false }));
    const iterm = new FakeBackend();
    const tmux = new FakeBackend("tmux");
    reg.add(iterm);
    reg.add(tmux);
    reg.setReported("tmux:%2", 7);
    expect(tmux.reported).toEqual([["%2", 7]]);
    expect(iterm.reported).toEqual([]);
    // Unknown prefix and unknown backend are no-ops, never throws.
    expect(() => reg.setReported("kitty:1", 3)).not.toThrow();
    expect(() => reg.setReported("nocolon", 3)).not.toThrow();
  });
});
