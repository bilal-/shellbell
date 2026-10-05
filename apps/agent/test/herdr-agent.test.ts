import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { CtrlMessage, InnerMessage, SessionInfo } from "@shellbell/protocol";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { startHerdrBackend } from "../src/backends/herdr/start.js";
import { BackendRegistry } from "../src/backends/registry.js";
import type { BackendEvent } from "../src/backends/types.js";
import { EventEngine, type Ring } from "../src/events.js";
import { createLogger } from "../src/log.js";
import { Notifier } from "../src/notifier.js";
import { ScreenTracker } from "../src/screen-tracker.js";
import { FakeHerdr } from "./fakes/fake-herdr.js";
import { waitFor } from "./fakes/wait.js";

/** Like waitFor, for async predicates. */
async function waitForAsync(fn: () => Promise<boolean>, ms = 3000): Promise<void> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (await fn()) return;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error("waitForAsync: condition not met in time");
}

const log = createLogger({ stdout: false });
const snapshot = () =>
  JSON.parse(
    readFileSync(join(import.meta.dirname, "fixtures", "herdr-session-snapshot.json"), "utf8"),
  ).result as unknown;

let server: FakeHerdr;
let handle: { stop(): void } | null = null;

beforeEach(async () => {
  server = new FakeHerdr();
  server.reply("session.snapshot", snapshot);
  await server.start();
});
afterEach(async () => {
  handle?.stop();
  handle = null;
  await server.stop();
});

/**
 * The real wiring in miniature: registry -> EventEngine -> Notifier, exactly as `Agent` composes
 * them, so the startup ordering bug (states emitted before anyone is listening, then flattened to
 * "unknown") cannot come back.
 */
function harness() {
  const registry = new BackendRegistry(log);
  const events = new EventEngine({
    notifyMinCommandMs: 10_000,
    idleQuietMs: 4000,
    idleMinActiveMs: 1500,
  });
  const rings: Ring[] = [];
  const notified: CtrlMessage[] = [];
  const notifier = new Notifier((m) => notified.push(m), log);
  events.on("ring", (r) => {
    rings.push(r);
    notifier.ring(r);
  });
  const seen: BackendEvent[] = [];
  registry.on((e) => {
    seen.push(e);
    events.onBackendEvent(e);
  });
  const sessions = async (): Promise<SessionInfo[]> =>
    (await registry.listSessions()).map((s) => {
      const known = events.stateOf(s.id);
      return known === "unknown" ? s : { ...s, state: known };
    });
  return { registry, events, rings, notified, seen, sessions };
}

describe("herdr through the agent's units", () => {
  it("shows an already-blocked agent without ringing, then rings on the next transition", async () => {
    const h = harness();
    // `pane.agent_status_changed` is a hint, not a mutation (
    // it schedules a `session.snapshot` refresh rather than applying directly, so the
    // fake's snapshot reply must track term_b's "world" status for that debounced refresh to
    // answer correctly.
    let termBStatus = "unknown";
    server.reply("session.snapshot", () => {
      const snap = snapshot() as {
        snapshot: { panes: { pane_id: string; agent_status: string }[] };
      };
      const pane = snap.snapshot.panes.find((p) => p.pane_id === "w1:p2");
      if (pane) pane.agent_status = termBStatus;
      return snap;
    });
    handle = startHerdrBackend({
      registry: h.registry,
      log,
      socketPath: server.path,
      retryMs: 20,
      backendOptions: { reconnectMs: 60_000, syncDebounceMs: 20 },
    });
    await waitFor(() => h.registry.connected().some((b) => b.name === "herdr"), 3000);

    // `registry.connected()` flips as soon as `connect()` resolves, which is before the bootstrap
    // snapshot has populated the panes -- so asserting on the first tick races the list and reads
    // `[]` on a slow runner (CI 2026-09-14). Same reason line ~157 waits for the re-adopted state.
    let list: SessionInfo[] = [];
    await waitForAsync(async () => {
      list = await h.sessions();
      return list.length === 3;
    }, 3000);
    expect(list.map((s) => [s.id, s.state])).toEqual([
      ["herdr:term_a", "unknown"],
      ["herdr:term_b", "unknown"],
      ["herdr:term_c", "blocked"],
    ]);
    // Adoption is not a transition: the phone sees `blocked`, but nothing rang.
    expect(h.rings).toEqual([]);
    expect(h.notified).toEqual([]);

    // Now a real transition: working -> blocked rings, and reaches the relay as `notify`. Each
    // push is a hint; the debounced snapshot it schedules is what actually applies the
    // transition once it answers with the new "world" status set above.
    termBStatus = "working";
    server.pushEvent("pane.agent_status_changed", { pane_id: "w1:p2", agent_status: "working" });
    await waitFor(() =>
      h.seen.some((e) => e.type === "agent-state" && e.sessionId === "herdr:term_b"),
    );
    termBStatus = "blocked";
    server.pushEvent("pane.agent_status_changed", { pane_id: "w1:p2", agent_status: "blocked" });
    await waitFor(() => h.rings.length === 1, 3000);
    expect(h.rings[0]).toMatchObject({ sessionId: "herdr:term_b", kind: "blocked" });
    expect(h.notified[0]).toMatchObject({
      type: "notify",
      sessionId: "herdr:term_b",
      kind: "blocked",
    });
    expect((await h.sessions()).find((s) => s.id === "herdr:term_b")?.state).toBe("blocked");
  });

  it("drops every herdr session when the socket dies and re-adopts without ringing", async () => {
    const h = harness();
    handle = startHerdrBackend({
      registry: h.registry,
      log,
      socketPath: server.path,
      retryMs: 20,
      backendOptions: { reconnectMs: 30, syncDebounceMs: 20 },
    });
    await waitFor(() => h.registry.connected().some((b) => b.name === "herdr"), 3000);
    const path = server.path;

    await server.stop();
    await waitFor(() => h.seen.filter((e) => e.type === "session-removed").length === 3, 3000);
    expect(h.registry.connected()).toEqual([]); // spec 8.12: dropped from hello.backends
    expect(await h.sessions()).toEqual([]);

    server = new FakeHerdr(path);
    server.reply("session.snapshot", snapshot);
    await server.start();
    await waitFor(() => h.registry.connected().some((b) => b.name === "herdr"), 5000);
    // term_c is still blocked, and it is a first sighting again -> state yes, ring no. The
    // re-adopted snapshot lands asynchronously after the reconnect, so wait for the state to
    // appear rather than asserting on the first tick (slow CI runners).
    let state: string | undefined;
    await waitForAsync(async () => {
      state = (await h.sessions()).find((s) => s.id === "herdr:term_c")?.state;
      return state === "blocked";
    }, 5000);
    expect(state).toBe("blocked");
    expect(h.rings).toEqual([]);
  });

  it("delivers a screen frame to a phone viewing a herdr pane after bumpRevision (spec 8.13, revised: no poll option needed)", async () => {
    const h = harness();
    const frames: { connId: string; msg: InnerMessage }[] = [];
    // The real wiring in miniature, ScreenTracker included: it subscribes to `screen-changed`
    // through the SAME registry the backend is added to, exactly like `Agent` composes them.
    const tracker = new ScreenTracker({
      backend: h.registry,
      sink: (connId, msg) => {
        frames.push({ connId, msg });
      },
      log,
      intervalMs: 30,
    });
    tracker.start();
    handle = startHerdrBackend({
      registry: h.registry,
      log,
      socketPath: server.path,
      retryMs: 20,
      backendOptions: { reconnectMs: 30, syncDebounceMs: 20 },
    });
    try {
      await waitFor(() => h.registry.connected().some((b) => b.name === "herdr"), 3000);
      server.reply("pane.read", () => ({
        type: "pane_read",
        read: { pane_id: "w1:p1", source: "visible", format: "ansi", revision: 0, text: "one\n" },
      }));

      // The phone views term_a: it gets an immediate snapshot frame just from viewing.
      tracker.setViewed("phone-1", "herdr:term_a");
      await waitFor(() => frames.length > 0, 3000);

      // Herdr has no `setWatched`/poller any more: a `pane_updated` revision bump alone is what
      // marks the session dirty and delivers the next frame -- exactly the production event path.
      // The screen content also has to actually change (a real revision bump implies real output),
      // or the tracker's own diff correctly finds nothing new to send.
      frames.length = 0;
      server.reply("pane.read", () => ({
        type: "pane_read",
        read: { pane_id: "w1:p1", source: "visible", format: "ansi", revision: 0, text: "two\n" },
      }));
      server.bumpRevision("w1:p1");
      await waitFor(() => frames.length > 0, 3000);
      expect(frames[0]?.connId).toBe("phone-1");
    } finally {
      tracker.stop();
    }
  });
});
