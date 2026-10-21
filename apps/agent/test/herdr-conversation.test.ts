import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { HerdrBackend } from "../src/backends/herdr/backend.js";
import { HerdrClient } from "../src/backends/herdr/client.js";
import { herdrTranscriptReference } from "../src/backends/herdr/conversation.js";
import type {
  AgentSessionInfo,
  PaneInfo,
  SessionSnapshotResult,
} from "../src/backends/herdr/types.js";
import { BackendRegistry } from "../src/backends/registry.js";
import type { BackendEvent } from "../src/backends/types.js";
import { createLogger, type Logger } from "../src/log.js";
import { FakeHerdr } from "./fakes/fake-herdr.js";
import { waitFor } from "./fakes/wait.js";

const ref: AgentSessionInfo = {
  source: "herdr:claude",
  agent: "claude",
  kind: "id",
  value: "session-one",
};
describe("Herdr integration reference validation", () => {
  it("accepts only explicit supported agent identities", () => {
    expect(herdrTranscriptReference(ref)).toEqual({
      agent: "claude",
      kind: "id",
      value: "session-one",
    });
    expect(
      herdrTranscriptReference({
        source: "herdr:codex",
        agent: "codex",
        kind: "path",
        value: "/test/rollout.jsonl",
      }),
    ).toEqual({ agent: "codex", kind: "path", value: "/test/rollout.jsonl" });
  });
  it.each([
    null,
    undefined,
    [],
    "claude",
    {},
    { ...ref, source: "screen" },
    { ...ref, agent: "unknown" },
    { ...ref, kind: "folder" },
    { ...ref, value: "../other" },
    { ...ref, value: "" },
    { ...ref, value: "x".repeat(257) },
    { ...ref, kind: "path", value: "relative.jsonl" },
    { ...ref, kind: "path", value: "/test/config.json" },
    { ...ref, kind: "path", value: "/test/\nprivate.jsonl" },
    { ...ref, kind: "path", value: "/test/../private.jsonl" },
    { ...ref, kind: "path", value: "/test//private.jsonl" },
    { ...ref, kind: "path", value: "/test/./private.jsonl" },
    { ...ref, kind: "path", value: "/test/\u0085private.jsonl" },
    { ...ref, kind: "path", value: "/test/\ud800private.jsonl" },
  ])("rejects missing or ambiguous native metadata %#", (value) => {
    expect(herdrTranscriptReference(value)).toBeNull();
  });
});

describe("Herdr conversation identity lifetime", () => {
  let server: FakeHerdr;
  let backend: HerdrBackend;
  let snapshot: SessionSnapshotResult;
  let pane: PaneInfo;
  const events: BackendEvent[] = [];
  const signal = () => new AbortController().signal;
  const proof = () => backend.conversationReference("term_a", signal());
  beforeEach(async () => {
    snapshot = JSON.parse(
      readFileSync(join(import.meta.dirname, "fixtures/herdr-session-snapshot.json"), "utf8"),
    ).result;
    pane = snapshot.snapshot.panes.find((p) => p.terminal_id === "term_a")!;
    pane.agent_session = { ...ref };
    server = new FakeHerdr();
    server.reply("ping", () => ({ type: "pong", version: "0.9.5", protocol: 20 }));
    server.reply("session.snapshot", () => structuredClone(snapshot));
    server.reply("pane.get", () => ({ type: "pane_info", pane: structuredClone(pane) }));
    await server.start();
    const log = createLogger({ stdout: false });
    backend = new HerdrBackend({
      client: new HerdrClient({ log, socketPath: server.path, requestTimeoutMs: 500 }),
      log,
      syncDebounceMs: 10,
      reconnectMs: 10,
      hostAppPollMs: 0,
      hostApps: async () => [],
      mouse: {
        available: false,
        configure: async () => {},
        close: () => {},
        click: async () => {},
      },
    });
    events.length = 0;
    backend.on((event) => events.push(event));
    await backend.connect();
  });
  afterEach(async () => {
    await backend?.close();
    await server?.stop();
  });

  async function update(reference: AgentSessionInfo | null) {
    const before = events.filter((e) => e.type === "conversation-changed").length;
    pane.agent_session = reference;
    pane.revision++;
    server.pushEvent("pane_updated", { pane: structuredClone(pane) });
    await waitFor(() => events.filter((e) => e.type === "conversation-changed").length > before);
  }

  it("rechecks the exact pane while keeping private identities out of session lists", async () => {
    const first = await proof();
    expect(first).toMatchObject({ agent: "claude", kind: "id", value: "session-one" });
    expect(await proof()).toEqual(first);
    expect(server.called("pane.get").at(-1)?.params).toEqual({ pane_id: pane.pane_id });
    expect(JSON.stringify(await backend.listSessions())).not.toContain("session-one");
    expect(JSON.stringify(events)).not.toContain("session-one");
  });

  it("does not let ordinary output invalidate an in-flight identity check", async () => {
    const first = await proof();
    const frozen = structuredClone(pane);
    server.reply("pane.get", () => ({ type: "pane_info", pane: frozen }));
    const count = server.called("pane.get").length;
    const release = server.gate("pane.get");
    const pending = proof();
    await waitFor(() => server.called("pane.get").length > count);
    pane.revision++;
    server.pushEvent("pane_updated", { pane: structuredClone(pane) });
    await waitFor(() => events.some((e) => e.type === "screen-changed"));
    release();
    expect(await pending).toEqual(first);
  });

  it("changes ownership across clear/resume even when the explicit session returns to the same id", async () => {
    const first = await proof();
    await update(null);
    expect(await proof()).toBeNull();
    await update({ ...ref });
    const resumed = await proof();
    expect(resumed?.value).toBe(first?.value);
    expect(resumed?.owner).not.toBe(first?.owner);
  });

  it("drops a late pane response after a newer explicit identity event", async () => {
    const frozen = structuredClone(pane);
    server.reply("pane.get", () => ({ type: "pane_info", pane: frozen }));
    const release = server.gate("pane.get");
    const pending = proof();
    await waitFor(() => server.called("pane.get").length === 1);
    await update({ ...ref, value: "session-two" });
    release();
    expect(await pending).toBeNull();
    server.reply("pane.get", () => ({ type: "pane_info", pane: structuredClone(pane) }));
    expect(await proof()).toMatchObject({ value: "session-two" });
  });

  it("does not let an old snapshot revert a freshly verified identity", async () => {
    const before = server.called("session.snapshot").length;
    const titleEvents = events.filter((e) => e.type === "title-changed").length;
    pane.foreground_cwd = "/test/held-snapshot";
    const frozen = structuredClone(snapshot);
    server.reply("session.snapshot", () => frozen);
    const release = server.gate("session.snapshot");
    server.pushEvent("workspace_renamed", { workspace_id: pane.workspace_id });
    await waitFor(() => server.called("session.snapshot").length > before);
    pane.agent_session = { ...ref, value: "session-two" };
    const current = await proof();
    expect(current?.value).toBe("session-two");
    release();
    await waitFor(() => events.filter((e) => e.type === "title-changed").length > titleEvents);
    expect(await proof()).toEqual(current);
  });

  it("ends the transport generation across reconnect even for an identical session id", async () => {
    const first = await proof();
    server.dropStreams();
    await waitFor(() => events.some((e) => e.type === "session-removed"));
    await vi.waitFor(async () => expect(await proof()).not.toBeNull());
    const next = await proof();
    expect(next?.value).toBe(first?.value);
    expect(next?.owner).not.toBe(first?.owner);
  });

  it("withholds proof after a lifecycle hint until its fresh snapshot settles", async () => {
    const first = await proof();
    const reads = server.called("pane.get").length;
    const changes = events.filter((e) => e.type === "conversation-changed").length;
    const releaseRead = server.gate("pane.get");
    const pending = proof();
    await waitFor(() => server.called("pane.get").length > reads);
    const releaseSnapshot = server.gate("session.snapshot");
    server.pushEvent("pane_moved", { pane_id: pane.pane_id });
    await waitFor(() => events.filter((e) => e.type === "conversation-changed").length > changes);
    releaseRead();
    expect(await pending).toBeNull();
    expect(await proof()).toBeNull();
    expect(server.called("pane.get").length).toBe(reads + 1);
    releaseSnapshot();
    await vi.waitFor(async () => expect(await proof()).not.toBeNull());
    expect((await proof())?.owner).not.toBe(first?.owner);
  });

  it("publishes an invalidation when a fresh snapshot changes the explicit identity", async () => {
    const first = await proof();
    pane.agent_session = { ...ref, value: "session-two" };
    server.pushEvent("workspace_renamed", { workspace_id: pane.workspace_id });
    await waitFor(() => events.some((e) => e.type === "conversation-changed"));
    const next = await proof();
    expect(next?.value).toBe("session-two");
    expect(next?.owner).not.toBe(first?.owner);
  });

  it.each([0, 2])(
    "keeps verified identity when an event revision is %s behind its probe",
    async (behind) => {
      const old = structuredClone(pane);
      pane.revision += 4;
      pane.agent_session = { ...ref, value: "session-two" };
      const current = await proof();
      const changes = events.filter((event) => event.type === "conversation-changed").length;
      server.pushEvent("pane_updated", { pane: { ...old, revision: pane.revision - behind } });
      await waitFor(() => events.some((event) => event.type === "screen-changed"));
      expect(events.filter((event) => event.type === "conversation-changed")).toHaveLength(changes);
      expect(await proof()).toEqual(current);
    },
  );

  it("ignores equal-revision identity replay, but still discovers a change in a fresh probe", async () => {
    const first = await proof();
    const changes = events.filter((event) => event.type === "conversation-changed").length;
    const screens = events.filter((event) => event.type === "screen-changed").length;
    pane.agent_session = { ...ref, value: "session-two" };
    server.pushEvent("pane_updated", { pane: structuredClone(pane) });
    server.pushEvent("pane.scroll_changed", {
      pane_id: pane.pane_id,
      scroll: { offset_from_bottom: 1, max_offset_from_bottom: 2 },
    });
    await waitFor(() => events.filter((event) => event.type === "screen-changed").length > screens);
    expect(events.filter((event) => event.type === "conversation-changed")).toHaveLength(changes);
    const next = await proof();
    expect(next?.value).toBe("session-two");
    expect(next?.owner).not.toBe(first?.owner);
  });

  it("lets the registry invalidate a discovery once, then returns its fresh ownership", async () => {
    const registry = new BackendRegistry(createLogger({ stdout: false }));
    registry.add(backend);
    expect(await registry.conversationReference("herdr:term_a", signal())).toMatchObject({
      value: "session-one",
    });
    pane.agent_session = { ...ref, value: "session-two" };
    expect(await registry.conversationReference("herdr:term_a", signal())).toBeNull();
    expect(await registry.conversationReference("herdr:term_a", signal())).toMatchObject({
      value: "session-two",
    });
  });

  it("drops an older response when two native probes finish out of order", async () => {
    const old = structuredClone(pane);
    const reads = server.called("pane.get").length;
    const release = server.gate("pane.get", true);
    const slow = proof();
    await waitFor(() => server.called("pane.get").length > reads);
    pane.agent_session = { ...ref, value: "session-two" };
    pane.revision++;
    expect(await proof()).toMatchObject({ value: "session-two" });
    server.reply("pane.get", () => ({ type: "pane_info", pane: old }));
    release();
    expect(await slow).toBeNull();
  });

  it("keeps dropped bootstrap events uncertain until a newer snapshot settles", async () => {
    await backend.close();
    backend.on((event) => events.push(event));
    const warn = vi.spyOn(Reflect.get(backend, "log") as Logger, "warn");
    const subscriptions = server.called("events.subscribe").length;
    const releaseSubscribe = server.gate("events.subscribe", true);
    const connecting = backend.connect();
    await waitFor(() => server.called("events.subscribe").length > subscriptions);
    const snapshots = server.called("session.snapshot").length;
    const releaseBootstrap = server.gate("session.snapshot", true);
    releaseSubscribe();
    await waitFor(() => server.called("session.snapshot").length > snapshots);
    const releaseNext = server.gate("session.snapshot");
    const ordinary = `${JSON.stringify({ event: "pane_updated", data: { pane: structuredClone(pane) } })}\n`;
    server.pushRaw(
      ordinary.repeat(1000) +
        JSON.stringify({ event: "pane_exited", data: { pane_id: pane.pane_id } }) +
        "\n",
    );
    await waitFor(() =>
      warn.mock.calls.some(([message]) => message.includes("bootstrap event buffer overflowed")),
    );
    releaseBootstrap();
    await connecting;
    expect(await proof()).toBeNull();
    releaseNext();
    await vi.waitFor(async () => expect(await proof()).not.toBeNull());
    warn.mockRestore();
  });

  it.each(["0.9.4", "dev-unknown", "0.9.5-rc.1", "0.9.5-dev", "0.9.5+unknown"])(
    "does not accept identities from an unqualified %s server",
    async (version) => {
      await backend.close();
      server.reply("ping", () => ({ type: "pong", version, protocol: 20 }));
      await backend.connect();
      expect(await proof()).toBeNull();
    },
  );

  it("discards a pending native response after its stream disconnects", async () => {
    const release = server.gate("pane.get");
    const pending = proof();
    await waitFor(() => server.called("pane.get").length > 0);
    server.dropStreams();
    await waitFor(() => events.some((event) => event.type === "session-removed"));
    release();
    expect(await pending).toBeNull();
  });

  it("changes owner when a pane disappears and reappears with the same ids", async () => {
    const first = await proof();
    const panes = snapshot.snapshot.panes;
    snapshot.snapshot.panes = panes.filter((p) => p.terminal_id !== "term_a");
    server.pushEvent("pane_closed", { pane_id: pane.pane_id });
    await waitFor(() =>
      events.some((event) => event.type === "session-removed" && event.sessionId === "term_a"),
    );
    snapshot.snapshot.panes = panes;
    server.pushEvent("pane_created", { pane_id: pane.pane_id });
    await vi.waitFor(async () => expect(await proof()).toMatchObject({ value: "session-one" }));
    expect((await proof())?.owner).not.toBe(first?.owner);
  });

  it("allows a native revision reset after a possibly replacing lifecycle event", async () => {
    const first = await proof();
    pane.revision = 0;
    pane.agent_session = { ...ref, value: "replacement-session" };
    server.pushEvent("pane_exited", { pane_id: pane.pane_id });
    await waitFor(() => events.some((event) => event.type === "conversation-changed"));
    await vi.waitFor(async () =>
      expect(await proof()).toMatchObject({ value: "replacement-session" }),
    );
    expect((await proof())?.owner).not.toBe(first?.owner);
  });

  it("does not let a held snapshot undo a probe that confirmed the unchanged identity", async () => {
    const first = await proof();
    const frozen = structuredClone(snapshot);
    const entry = frozen.snapshot.panes.find((p) => p.terminal_id === "term_a")!;
    entry.agent_session = { ...ref, value: "intermediate-session" };
    entry.foreground_cwd = "/test/intermediate-snapshot";
    server.reply("session.snapshot", () => frozen);
    const snapshots = server.called("session.snapshot").length;
    const titles = events.filter((event) => event.type === "title-changed").length;
    const release = server.gate("session.snapshot");
    server.pushEvent("workspace_renamed", { workspace_id: pane.workspace_id });
    await waitFor(() => server.called("session.snapshot").length > snapshots);
    expect(await proof()).toEqual(first);
    release();
    await waitFor(() => events.filter((event) => event.type === "title-changed").length > titles);
    expect(await proof()).toEqual(first);
  });

  it("accepts a reset identity even if a late old event raises the general screen revision", async () => {
    const old = structuredClone(pane);
    pane.revision = 0;
    pane.agent_session = { ...ref, value: "reset-session" };
    const snapshots = server.called("session.snapshot").length;
    const screens = events.filter((event) => event.type === "screen-changed").length;
    const release = server.gate("session.snapshot");
    server.pushEvent("pane_exited", { pane_id: pane.pane_id });
    await waitFor(() => server.called("session.snapshot").length > snapshots);
    server.pushEvent("pane_updated", { pane: { ...old, revision: old.revision + 1 } });
    await waitFor(() => events.filter((event) => event.type === "screen-changed").length > screens);
    release();
    await vi.waitFor(async () => expect(await proof()).toMatchObject({ value: "reset-session" }));
  });

  it.each(["pane", "terminal", "revision"])(
    "refuses mismatching %s identity in the reply",
    async (part) => {
      server.reply("pane.get", () => ({
        type: "pane_info",
        pane: {
          ...pane,
          ...(part === "pane"
            ? { pane_id: "other" }
            : part === "terminal"
              ? { terminal_id: "other" }
              : { revision: -1 }),
        },
      }));
      expect(await proof()).toBeNull();
    },
  );

  it("cancels an outstanding native proof and never guesses from title/cwd", async () => {
    server.silence("pane.get");
    const controller = new AbortController();
    const pending = backend.conversationReference("term_a", controller.signal);
    await waitFor(() => server.called("pane.get").length > 0);
    controller.abort();
    expect(await pending).toBeNull();
    server.reply("pane.get", () => ({
      type: "pane_info",
      pane: {
        ...pane,
        agent_session: undefined,
        agent: "claude",
        title: "Claude Code",
        cwd: "/test/same-folder",
      },
    }));
    expect(await proof()).toBeNull();
  });
});
