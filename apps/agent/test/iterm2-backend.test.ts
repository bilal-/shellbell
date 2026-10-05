import { create } from "@bufbuild/protobuf";
import { describe, expect, it, vi } from "vitest";
import { ITerm2Backend } from "../src/backends/iterm2/backend.js";
import type { ClientSub } from "../src/backends/iterm2/client.js";
import {
  FocusChangedNotificationSchema,
  LayoutChangedNotificationSchema,
  ListSessionsResponseSchema,
  NewSessionNotificationSchema,
  NotificationSchema,
  PromptNotificationCommandEndSchema,
  PromptNotificationCommandStartSchema,
  PromptNotificationPromptSchema,
  PromptNotificationSchema,
  ScreenUpdateNotificationSchema,
  type ServerOriginatedMessage,
  ServerOriginatedMessageSchema,
  TerminateSessionNotificationSchema,
  VariableChangedNotificationSchema,
} from "../src/backends/iterm2/gen/iterm2_pb.js";
import { BackendRegistry } from "../src/backends/registry.js";
import { BackendUnavailable } from "../src/backends/types.js";
import { createLogger } from "../src/log.js";

import { FakeClient, layout } from "./fakes/fake-iterm2.js";
import { waitFor } from "./fakes/wait.js";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

function holdReply(client: FakeClient, matches: (sub: ClientSub) => boolean) {
  const started = deferred<void>();
  const result = deferred<ServerOriginatedMessage>();
  const original = client.request.bind(client);
  let held = false;
  let reply!: ServerOriginatedMessage;
  vi.spyOn(client, "request").mockImplementation(async (sub) => {
    if (!held && matches(sub)) {
      held = true;
      reply = await original(sub);
      started.resolve();
      return result.promise;
    }
    return original(sub);
  });
  return {
    started: started.promise,
    release: () => result.resolve(reply),
    reject: () => result.reject(new Error("obsolete RPC")),
  };
}

import { FakeBackend } from "./fakes/fake-backend.js";

const log = createLogger({ stdout: false });

describe("ITerm2Backend", () => {
  it("does not treat a reported session path as proven host-local", async () => {
    const b = new ITerm2Backend(new FakeClient() as never, log);
    await b.connect();
    try {
      const sessions = await b.listSessions();
      const session = sessions[0]!;
      const facts = await b.notificationFacts(session.id);
      expect(facts).toMatchObject({
        sessionId: session.id,
        locality: "unknown",
        title: session.title,
      });
      expect(facts?.sessionLabel).toContain("iTerm2");
      expect(await b.notificationFacts("missing")).toBeUndefined();
    } finally {
      await b.close();
    }
  });
  it("disconnect discards old focus after reconnect reuses native IDs", async () => {
    const client = new FakeClient();
    const gate = holdReply(client, (sub) => sub.case === "focusRequest");
    const b = new ITerm2Backend(client as never, log, { minMs: 60_000 });
    const oldBoot = b.connect();
    try {
      await gate.started;
      client.connected = false;
      client.emit("close");
      client.focused = "S1";
      await b.connect();
      gate.release();
      await oldBoot;
      expect((await b.listSessions()).filter((s) => s.isFocusedOnMac).map((s) => s.id)).toEqual([
        "S1",
      ]);
    } finally {
      gate.release();
      await b.close();
      await oldBoot;
    }
  });
  it("disconnect keeps the new layout drain owned while an obsolete metadata drain finishes", async () => {
    const client = new FakeClient();
    const metadata = (sub: ClientSub) =>
      sub.case === "variableRequest" &&
      sub.value.get[0] === "session.name" &&
      sub.value.scope.value === "S1";
    const oldGate = holdReply(client, metadata);
    const b = new ITerm2Backend(client as never, log, { minMs: 60_000 });
    const oldBoot = b.connect();
    let newGate: ReturnType<typeof holdReply> | undefined;
    let newBoot: Promise<void> | undefined;
    try {
      await oldGate.started;
      client.connected = false;
      client.emit("close");
      client.titles.S1 = "current title";
      vi.mocked(client.request).mockRestore();
      newGate = holdReply(client, metadata);
      newBoot = b.connect();
      await newGate.started;
      const resize = (width: number) => {
        const next = layout();
        const first = next.windows[0]!.tabs[0]!.root!.links[0]!.child;
        if (first.case !== "session") throw new Error("expected fixture session");
        first.value.gridSize!.width = width;
        client.emit(
          "notification",
          create(NotificationSchema, {
            layoutChangedNotification: create(LayoutChangedNotificationSchema, {
              listSessionsResponse: next,
            }),
          }),
        );
      };
      resize(200);
      oldGate.release();
      await oldBoot;
      // An old while/finally must neither consume pending work nor unlock the new drain.
      expect((await b.listSessions())[0]?.cols).toBe(80);
      resize(300);
      expect((await b.listSessions())[0]?.cols).toBe(80);
      newGate.release();
      await newBoot;
      expect((await b.listSessions())[0]).toMatchObject({ cols: 300, title: "current title" });
    } finally {
      oldGate.release();
      newGate?.release();
      await b.close();
      await Promise.all([oldBoot, newBoot]);
    }
  });

  it.each(["resolve", "reject"] as const)(
    "close during a pending reconnect ignores its late %s and never retries",
    async (settle) => {
      vi.useFakeTimers();
      const client = new FakeClient();
      const b = new ITerm2Backend(client as never, log, { minMs: 10 });
      const gate = deferred<void>();
      try {
        await b.connect();
        vi.spyOn(client, "connect").mockImplementation(async () => {
          await gate.promise;
          client.connected = true;
        });
        client.connected = false;
        client.emit("close");
        await vi.advanceTimersByTimeAsync(10);
        await b.close();
        const events: string[] = [];
        b.on((e) => events.push(e.type));
        const requests = client.calls.length;
        if (settle === "resolve") gate.resolve();
        else gate.reject(new Error("old connect failed"));
        await vi.advanceTimersByTimeAsync(60_000);
        expect(b.isConnected).toBe(false);
        expect(client.connected).toBe(false);
        expect(await b.listSessions()).toEqual([]);
        expect(client.calls).toHaveLength(requests);
        expect(client.connect).toHaveBeenCalledTimes(1);
        expect(events).toEqual([]);
      } finally {
        gate.resolve();
        await b.close();
        vi.useRealTimers();
      }
    },
  );

  it("disconnect discards an obsolete bootstrap rejection after a newer bootstrap succeeds", async () => {
    const client = new FakeClient();
    const gate = holdReply(client, (sub) => sub.case === "listSessionsRequest");
    const b = new ITerm2Backend(client as never, log, { minMs: 60_000 });
    const oldBoot = b.connect();
    try {
      await gate.started;
      client.connected = false;
      client.emit("close");
      await b.connect();
      gate.reject();
      await expect(oldBoot).resolves.toBeUndefined();
      expect(b.isConnected).toBe(true);
      expect(await b.listSessions()).toHaveLength(3);
    } finally {
      gate.release();
      await b.close();
      await oldBoot;
    }
  });
  it.each(["notificationRequest", "listSessionsRequest"] as const)(
    "disconnect discards an obsolete bootstrap %s response",
    async (rpc) => {
      const client = new FakeClient();
      const gate = holdReply(client, (sub) => sub.case === rpc);
      const b = new ITerm2Backend(client as never, log, { minMs: 60_000 });
      const boot = b.connect();
      try {
        await gate.started;
        client.connected = false;
        client.emit("close");
        const events: string[] = [];
        b.on((e) => events.push(e.type));
        const calls = client.calls.length;
        gate.release();
        await boot;
        expect(await b.listSessions()).toEqual([]);
        expect(events).toEqual([]);
        expect(client.calls).toHaveLength(calls);
      } finally {
        gate.release();
        await b.close();
        await boot;
      }
    },
  );

  it.each(["release", "reject"] as const)(
    "disconnect allows reused IDs to bootstrap while old metadata waits, then ignores its %s",
    async (settle) => {
      const client = new FakeClient();
      const gate = holdReply(
        client,
        (sub) =>
          sub.case === "variableRequest" &&
          sub.value.get[0] === "session.name" &&
          sub.value.scope.value === "S1",
      );
      const b = new ITerm2Backend(client as never, log, { minMs: 60_000 });
      const boot = b.connect();
      let reconnect: Promise<void> | undefined;
      try {
        await gate.started;
        client.connected = false;
        client.emit("close");
        client.titles.S1 = "new title";
        client.paths.S1 = "/new/path";
        client.jobNames.S1 = "new-job";
        let recovered = false;
        reconnect = b.connect().then(() => {
          recovered = true;
        });
        await waitFor(() => recovered);
        const events: string[] = [];
        b.on((e) => events.push(e.type));
        gate[settle]();
        await boot;
        expect((await b.listSessions())[0]).toMatchObject({
          id: "S1",
          title: "new title",
          cwd: "/new/path",
        });
        expect(b.hostJob("S1")).toBe("new-job");
        expect(events).toEqual([]);
      } finally {
        gate.release();
        await b.close();
        await Promise.all([boot, reconnect]);
      }
    },
  );

  it.each(["release", "reject"] as const)(
    "disconnect ignores the %s of an obsolete new-session layout query",
    async (settle) => {
      const client = new FakeClient();
      const b = new ITerm2Backend(client as never, log, { minMs: 60_000 });
      try {
        await b.connect();
        const gate = holdReply(client, (sub) => sub.case === "listSessionsRequest");
        client.emit(
          "notification",
          create(NotificationSchema, {
            newSessionNotification: create(NewSessionNotificationSchema, { sessionId: "old" }),
          }),
        );
        await gate.started;
        client.connected = false;
        client.emit("close");
        vi.spyOn(client, "request").mockImplementation(async (sub) => {
          if (sub.case === "listSessionsRequest")
            return create(ServerOriginatedMessageSchema, {
              submessage: {
                case: "listSessionsResponse",
                value: create(ListSessionsResponseSchema, {}),
              },
            });
          return FakeClient.prototype.request.call(client, sub);
        });
        await b.connect();
        const events: string[] = [];
        b.on((e) => events.push(e.type));
        gate[settle]();
        // Drain the finite RPC continuation chain, including its rejection handler.
        await new Promise<void>((resolve) => setImmediate(resolve));
        expect(await b.listSessions()).toEqual([]);
        expect(events).toEqual([]);
      } finally {
        await b.close();
      }
    },
  );
  it.each(["transport", "intentional"])(
    "%s disconnect invalidates health and removes only its sessions before notifying observers",
    async (kind) => {
      const client = new FakeClient();
      const b = new ITerm2Backend(client as never, log, { minMs: 60_000 });
      const registry = new BackendRegistry(log);
      registry.add(b);
      const other = new FakeBackend("tmux");
      other.addSession("other", {});
      registry.add(other);
      try {
        await b.connect();
        expect(registry.connected().map((x) => x.name)).toEqual(["iterm2", "tmux"]);
        const removed: string[] = [];
        const observations: { connected: string[]; sessions: Promise<unknown> }[] = [];
        b.on((e) => {
          if (e.type !== "session-removed") return;
          removed.push(e.sessionId);
          observations.push({
            connected: registry.connected().map((x) => x.name),
            sessions: b.listSessions(),
          });
        });
        if (kind === "transport") {
          client.connected = false;
          client.emit("close");
          client.emit("close");
        } else await b.close();
        expect(registry.connected().map((x) => x.name)).toEqual(["tmux"]);
        expect(removed.sort()).toEqual(["S1", "S2", "S3"]);
        for (const observation of observations) {
          expect(observation.connected).toEqual(["tmux"]);
          expect(await observation.sessions).toEqual([]);
        }
        expect((await registry.listSessions()).map((s) => s.id)).toEqual(["tmux:other"]);
        await b.close();
        expect(removed).toHaveLength(3);
      } finally {
        await b.close();
      }
    },
  );
  it("lists sessions with titles, cwd, layout positions and focus; exposes tmux window ids", async () => {
    const client = new FakeClient();
    const b = new ITerm2Backend(client as never, log);
    await b.connect();
    const list = await b.listSessions();
    expect(
      list.map((s) => [s.id, s.title, s.cwd, s.tabIndex, s.paneIndex, s.isFocusedOnMac]),
    ).toEqual([
      ["S1", "title-S1", "/home/S1", 0, 0, false],
      ["S2", "title-S2", "/home/S2", 0, 1, true],
      ["S3", "title-S3", "/home/S3", 1, 0, false],
    ]);
    expect(list[2]?.cols).toBe(100);
    expect(b.tmuxWindowIds?.()).toEqual(new Set(["@5"]));
    // Adoption fetches `jobName` too (default "zsh" from the fake) -- but S3 is a `-CC`
    // integration tab (it has a `tmuxWindowId`), so `hostJob` reports it as `undefined`: the
    // existing tmux-side rule de-dupes it instead.
    expect(b.hostJob("S1")).toBe("zsh");
    expect(b.hostJob("S3")).toBeUndefined();

    const notifs = client.calls.filter((c) => c.case === "notificationRequest");
    expect(notifs.length).toBeGreaterThanOrEqual(4 + 3 * 5); // 4 global + per session: screen, prompt, 3 variables

    const jobNameSub = notifs.find(
      (c) =>
        c.case === "notificationRequest" &&
        c.value.session === "S1" &&
        c.value.arguments.case === "variableMonitorRequest" &&
        c.value.arguments.value.name === "jobName",
    );
    expect(
      jobNameSub?.case === "notificationRequest" &&
        jobNameSub.value.arguments.case === "variableMonitorRequest"
        ? [jobNameSub.value.arguments.value.scope, jobNameSub.value.arguments.value.identifier]
        : undefined,
    ).toEqual([1, "S1"]); // VariableScope.SESSION, session id

    const promptSub = notifs.find(
      (c) =>
        c.case === "notificationRequest" &&
        c.value.session === "S1" &&
        c.value.arguments.case === "promptMonitorRequest",
    );
    expect(
      promptSub?.case === "notificationRequest" &&
        promptSub.value.arguments.case === "promptMonitorRequest"
        ? promptSub.value.arguments.value.modes
        : undefined,
    ).toEqual([0, 1, 2].map((i) => i + 1)); // PROMPT, COMMAND_START, COMMAND_END

    const nameSub = notifs.find(
      (c) =>
        c.case === "notificationRequest" &&
        c.value.session === "S1" &&
        c.value.arguments.case === "variableMonitorRequest" &&
        c.value.arguments.value.name === "session.name",
    );
    expect(
      nameSub?.case === "notificationRequest" &&
        nameSub.value.arguments.case === "variableMonitorRequest"
        ? [nameSub.value.arguments.value.scope, nameSub.value.arguments.value.identifier]
        : undefined,
    ).toEqual([1, "S1"]); // VariableScope.SESSION, session id

    // Re-listing (a second LayoutChange for the same sessions) must not re-issue variable
    // requests for sessions already subscribed -- only the initial per-session requests exist.
    const variableReqsBefore = client.calls.filter((c) => c.case === "variableRequest").length;
    client.emit(
      "notification",
      create(NotificationSchema, { layoutChangedNotification: { listSessionsResponse: layout() } }),
    );
    await new Promise((r) => setTimeout(r, 0));
    const variableReqsAfter = client.calls.filter((c) => c.case === "variableRequest").length;
    expect(variableReqsAfter).toBe(variableReqsBefore);
  });

  it("getScreen requests screen-only contents with styles and converts with absolute scrollback and screen-relative cursor", async () => {
    const client = new FakeClient();
    const b = new ITerm2Backend(client as never, log);
    await b.connect();
    const s = await b.getScreen("S1");
    expect(s.rows).toBe(24);
    expect(s.lines[0]).toEqual({ r: [{ t: "hello" }] });
    expect(s.scrollbackTotal).toBe(100);
    expect(s.cursor).toEqual({ x: 5, y: 1 });

    const req = client.calls.find((c) => c.case === "getBufferRequest");
    expect(
      req?.case === "getBufferRequest" ? req.value.lineRange?.screenContentsOnly : undefined,
    ).toBe(true);
    expect(req?.case === "getBufferRequest" ? req.value.includeStyles : undefined).toBe(true);
  });

  it("maps notifications to backend events", async () => {
    const client = new FakeClient();
    const b = new ITerm2Backend(client as never, log);
    await b.connect();
    const events: string[] = [];
    b.on((e) => events.push(e.type + ("sessionId" in e ? `:${e.sessionId}` : "")));

    client.emit(
      "notification",
      create(NotificationSchema, {
        screenUpdateNotification: create(ScreenUpdateNotificationSchema, { session: "S1" }),
      }),
    );
    client.emit(
      "notification",
      create(NotificationSchema, {
        promptNotification: create(PromptNotificationSchema, {
          session: "S1",
          event: {
            case: "commandStart",
            value: create(PromptNotificationCommandStartSchema, { command: "ls" }),
          },
        }),
      }),
    );
    client.emit(
      "notification",
      create(NotificationSchema, {
        promptNotification: create(PromptNotificationSchema, {
          session: "S1",
          event: {
            case: "commandEnd",
            value: create(PromptNotificationCommandEndSchema, { status: 0 }),
          },
        }),
      }),
    );
    client.emit(
      "notification",
      create(NotificationSchema, {
        promptNotification: create(PromptNotificationSchema, {
          session: "S1",
          event: { case: "prompt", value: create(PromptNotificationPromptSchema, {}) },
        }),
      }),
    );
    client.emit(
      "notification",
      create(NotificationSchema, {
        focusChangedNotification: create(FocusChangedNotificationSchema, {
          event: { case: "session", value: "S3" },
        }),
      }),
    );
    client.emit(
      "notification",
      create(NotificationSchema, {
        variableChangedNotification: create(VariableChangedNotificationSchema, {
          identifier: "S1",
          name: "session.name",
          jsonNewValue: JSON.stringify("renamed"),
        }),
      }),
    );
    client.emit(
      "notification",
      create(NotificationSchema, {
        terminateSessionNotification: create(TerminateSessionNotificationSchema, {
          sessionId: "S2",
        }),
      }),
    );
    client.emit(
      "notification",
      create(NotificationSchema, {
        newSessionNotification: create(NewSessionNotificationSchema, { sessionId: "S9" }),
      }),
    );

    expect(events).toEqual([
      "screen-changed:S1",
      "command-start:S1",
      "command-end:S1",
      "prompt:S1",
      "focus-changed",
      "title-changed:S1",
      "session-removed:S2",
      "layout-changed",
      "session-added:S9",
    ]);

    const list = await b.listSessions();
    expect(list.find((s) => s.id === "S1")?.title).toBe("renamed");

    // Let the new_session-triggered ListSessions refresh (fire-and-forget) settle before the
    // test ends, so it can't leak a pending timer/rejection into the next test.
    await new Promise((r) => setTimeout(r, 0));
  });

  it("a jobName variable-change notification updates hostJob (spec 8.12)", async () => {
    const client = new FakeClient();
    client.jobNames = { S1: "herdr" };
    const b = new ITerm2Backend(client as never, log);
    await b.connect();
    expect(b.hostJob("S1")).toBe("herdr"); // adoption fetched it
    expect(b.hostJob("S2")).toBe("zsh");

    const events: string[] = [];
    b.on((e) => events.push(e.type + ("sessionId" in e ? `:${e.sessionId}` : "")));
    client.emit(
      "notification",
      create(NotificationSchema, {
        variableChangedNotification: create(VariableChangedNotificationSchema, {
          identifier: "S2",
          name: "jobName",
          jsonNewValue: JSON.stringify("tmux"),
        }),
      }),
    );
    expect(b.hostJob("S2")).toBe("tmux");
    expect(events).toEqual(["title-changed:S2"]);

    // Unknown session id: no-op, does not throw.
    client.emit(
      "notification",
      create(NotificationSchema, {
        variableChangedNotification: create(VariableChangedNotificationSchema, {
          identifier: "bogus",
          name: "jobName",
          jsonNewValue: JSON.stringify("herdr"),
        }),
      }),
    );
    expect(b.hostJob("bogus")).toBeUndefined();
  });

  it("a layout-change notification for an already-subscribed session keeps hostJob (fix round 1)", async () => {
    const client = new FakeClient();
    client.jobNames = { S1: "herdr" };
    const b = new ITerm2Backend(client as never, log);
    await b.connect();
    expect(b.hostJob("S1")).toBe("herdr");

    // A layout-change notification that keeps the same sessions (e.g. a focus/size ripple)
    // rebuilds each Native record from scratch -- `runApplyLayout` must carry `job` forward from
    // the previous record the same way it already carries `cwd`, or the host session's hostJob is
    // wiped back to `undefined` and it reappears in `listSessions()` for good.
    client.emit(
      "notification",
      create(NotificationSchema, { layoutChangedNotification: { listSessionsResponse: layout() } }),
    );
    await new Promise((r) => setTimeout(r, 0));
    expect(b.hostJob("S1")).toBe("herdr");
  });

  it("a failing new_session ListSessions refresh never produces an unhandled rejection, and the backend stays connected", async () => {
    const client = new FakeClient();
    const b = new ITerm2Backend(client as never, log);
    await b.connect();

    let unhandled: unknown;
    const onUnhandled = (err: unknown) => {
      unhandled = err;
    };
    process.on("unhandledRejection", onUnhandled);
    try {
      client.failListSessions = 1;
      const events: string[] = [];
      b.on((e) => events.push(e.type));
      client.emit(
        "notification",
        create(NotificationSchema, {
          newSessionNotification: create(NewSessionNotificationSchema, { sessionId: "S9" }),
        }),
      );
      // session-added is emitted synchronously, before the failing ListSessions settles.
      expect(events).toEqual(["session-added"]);
      await new Promise((r) => setTimeout(r, 20));
      expect(unhandled).toBeUndefined();
      expect(client.connected).toBe(true);
    } finally {
      process.off("unhandledRejection", onUnhandled);
    }
  });

  it(
    "reconnects with exponential backoff while retries fail, resets after a successful connect, " +
      "and stops after close()",
    async () => {
      vi.useFakeTimers();
      const client = new FakeClient();
      const b = new ITerm2Backend(client as never, log, { minMs: 10, maxMs: 40 });
      await b.connect();
      expect(client.connects).toBe(1);

      // Drop the connection; the next three retries (10 ms, 20 ms, 40 ms backoff) all fail.
      client.connected = false;
      client.failConnects = 3;
      client.emit("close");

      await vi.advanceTimersByTimeAsync(15);
      expect(client.connects).toBe(2); // retry #1 at +10 ms (fails)

      await vi.advanceTimersByTimeAsync(10); // elapsed 25 ms; retry #2 due at +30 ms, not yet
      expect(client.connects).toBe(2);

      await vi.advanceTimersByTimeAsync(10); // elapsed 35 ms; retry #2 fired at +30 ms (fails)
      expect(client.connects).toBe(3);

      await vi.advanceTimersByTimeAsync(30); // elapsed 65 ms; retry #3 due at +70 ms, not yet
      expect(client.connects).toBe(3);

      await vi.advanceTimersByTimeAsync(10); // elapsed 75 ms; retry #3 fired at +70 ms (fails, capped at 40 ms backoff)
      expect(client.connects).toBe(4);

      // Let the next retry (+40 ms, still capped) succeed.
      client.failConnects = 0;
      await vi.advanceTimersByTimeAsync(45); // elapsed 120 ms; retry #4 fired at +110 ms (succeeds)
      expect(client.connects).toBe(5);
      expect(client.connected).toBe(true);

      // Reset-on-success: one more drop retries at the base 10 ms again, not a longer delay.
      client.connected = false;
      client.emit("close");
      await vi.advanceTimersByTimeAsync(15);
      expect(client.connects).toBe(6); // back to the base 10 ms delay

      // close() cancels any pending/future retry.
      client.connected = false;
      await b.close();
      client.emit("close");
      await vi.advanceTimersByTimeAsync(200);
      expect(client.connects).toBe(6); // close() cancels the retry loop
      vi.useRealTimers();
    },
  );

  it("connect() rejects with BackendUnavailable when the post-handshake ListSessions fails", async () => {
    const client = new FakeClient();
    client.failListSessions = 1;
    const b = new ITerm2Backend(client as never, log);
    await expect(b.connect()).rejects.toThrow(BackendUnavailable);
  });

  it(
    "a post-handshake failure (socket connects, ListSessions fails) does not reset the backoff " +
      "attempt -- the retry delay keeps growing",
    async () => {
      vi.useFakeTimers();
      const client = new FakeClient();
      const b = new ITerm2Backend(client as never, log, { minMs: 10, maxMs: 1000 });
      await b.connect();
      const lsAttempts = () => client.calls.filter((c) => c.case === "listSessionsRequest").length;
      expect(lsAttempts()).toBe(1);

      // The socket-level connect succeeds and stays connected throughout (a post-handshake RPC
      // failure does not necessarily close the socket); only the post-handshake ListSessions
      // fails, twice. `client.calls` (not `client.connects`, which only counts socket-level
      // connects) is the reliable per-attempt counter here, since `ITerm2Backend.connect()`
      // skips re-dialing a socket that's already open. If `attempt` were wrongly reset as soon
      // as the post-handshake sequence started (the bug this test guards against), the retry
      // delay would flatten back to 10 ms each time instead of growing 10 ms -> 20 ms.
      client.connected = false;
      client.failListSessions = 2;
      client.emit("close");

      await vi.advanceTimersByTimeAsync(15);
      expect(lsAttempts()).toBe(2); // retry #1 at +10 ms: ListSessions fails

      await vi.advanceTimersByTimeAsync(10); // elapsed 25 ms; retry #2 due at +30 ms, not yet
      expect(lsAttempts()).toBe(2);

      await vi.advanceTimersByTimeAsync(10); // elapsed 35 ms; retry #2 fires at +30 ms (fails again)
      expect(lsAttempts()).toBe(3);

      client.failListSessions = 0;
      await vi.advanceTimersByTimeAsync(45); // retry #3 at +40 ms more succeeds
      expect(lsAttempts()).toBe(4);
      expect(client.connected).toBe(true);
      vi.useRealTimers();
    },
  );

  it("sendText maps SESSION_NOT_FOUND to SessionGone, and suppresses broadcast", async () => {
    const client = new FakeClient();
    const b = new ITerm2Backend(client as never, log);
    await b.connect();
    await b.sendText("S1", "ls\r");
    await expect(b.sendText("gone", "x")).rejects.toThrow(/session gone/);

    const req = client.calls.find((c) => c.case === "sendTextRequest" && c.value.session === "S1");
    expect(req?.case === "sendTextRequest" ? req.value.suppressBroadcast : undefined).toBe(true);
  });
});
