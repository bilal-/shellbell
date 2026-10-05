import { create } from "@bufbuild/protobuf";
import { describe, expect, it, vi } from "vitest";
import { ITerm2Backend } from "../src/backends/iterm2/backend.js";
import type { ClientSub } from "../src/backends/iterm2/client.js";
import {
  CellStyleSchema,
  CoordRangeSchema,
  CoordSchema,
  GetBufferResponseSchema,
  GetPropertyResponseSchema,
  LayoutChangedNotificationSchema,
  LineContentsSchema,
  NotificationSchema,
  RangeSchema,
  ScreenUpdateNotificationSchema,
  type ServerOriginatedMessage,
  ServerOriginatedMessageSchema,
  TerminateSessionNotificationSchema,
  WindowedCoordRangeSchema,
} from "../src/backends/iterm2/gen/iterm2_pb.js";
import {
  type HistoryCapture,
  type HistoryReadRequest,
  SessionGone,
} from "../src/backends/types.js";
import { createLogger } from "../src/log.js";
import { FakeClient, layout } from "./fakes/fake-iterm2.js";

class HistoryClient extends FakeClient {
  facts = { overflow: 7, history: 3, grid: 2, first_visible: 10 };
  nativeCalls: ClientSub[] = [];
  alter?: (reply: ServerOriginatedMessage, index: number) => void | Promise<void>;
  beforeOther?: (sub: ClientSub) => Promise<void>;

  private async native(sub: ClientSub, reply: ServerOriginatedMessage) {
    const index = this.nativeCalls.push(sub) - 1;
    await this.alter?.(reply, index);
    return reply;
  }

  override async request(sub: ClientSub) {
    if (sub.case === "getPropertyRequest") {
      return this.native(
        sub,
        create(ServerOriginatedMessageSchema, {
          submessage: {
            case: "getPropertyResponse",
            value: create(GetPropertyResponseSchema, {
              status: 0,
              jsonValue: JSON.stringify(this.facts),
            }),
          },
        }),
      );
    }
    if (sub.case === "getBufferRequest") {
      const range = sub.value.lineRange?.windowedCoordRange?.coordRange;
      const from = range?.start?.y ?? BigInt(this.facts.overflow + this.facts.history);
      const to = range?.end?.y ?? from + BigInt(this.facts.grid);
      return this.native(
        sub,
        create(ServerOriginatedMessageSchema, {
          submessage: {
            case: "getBufferResponse",
            value: create(GetBufferResponseSchema, {
              status: 0,
              contents: Array.from({ length: Number(to - from) }, (_, i) =>
                create(LineContentsSchema, { text: `row-${from + BigInt(i)}` }),
              ),
              cursor: create(CoordSchema, { x: 0, y: from }),
              windowedCoordRange: create(WindowedCoordRangeSchema, {
                coordRange: create(CoordRangeSchema, {
                  start: create(CoordSchema, { x: 0, y: from }),
                  end: create(CoordSchema, { x: 0, y: to }),
                }),
              }),
            }),
          },
        }),
      );
    }
    await this.beforeOther?.(sub);
    const reply = await super.request(sub);
    if (reply.submessage.case === "listSessionsResponse") {
      const session = reply.submessage.value.windows[0]?.tabs[0]?.root?.links[0]?.child;
      if (session?.case === "session" && session.value.gridSize) session.value.gridSize.height = 2;
    }
    return reply;
  }
}

function output(client: HistoryClient) {
  client.emit(
    "notification",
    create(NotificationSchema, {
      screenUpdateNotification: create(ScreenUpdateNotificationSchema, { session: "S1" }),
    }),
  );
}

function relayout(client: HistoryClient) {
  const next = layout();
  const session = next.windows[0]!.tabs[0]!.root!.links[0]!.child;
  if (session.case === "session") session.value.gridSize!.height = 2;
  client.emit(
    "notification",
    create(NotificationSchema, {
      layoutChangedNotification: create(LayoutChangedNotificationSchema, {
        listSessionsResponse: next,
      }),
    }),
  );
}

function remove(client: HistoryClient) {
  client.emit(
    "notification",
    create(NotificationSchema, {
      terminateSessionNotification: create(TerminateSessionNotificationSchema, { sessionId: "S1" }),
    }),
  );
}

function disconnect(client: HistoryClient) {
  client.connected = false;
  client.emit("close");
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

// Preserve the real property RPC/parser. Queue a notification only after the helper
// finishes, so checking inside the helper cannot protect the caller's continuation.
function inFactsContinuation(backend: ITerm2Backend, stage: number, action: () => void) {
  const helper = backend as unknown as { fetchHistoryFacts(id: string): Promise<unknown> };
  const original = helper.fetchHistoryFacts.bind(backend);
  let calls = 0;
  return vi.spyOn(helper, "fetchHistoryFacts").mockImplementation(async (id) => {
    const facts = await original(id);
    if (calls++ === stage) queueMicrotask(action);
    return facts;
  });
}

async function fixture() {
  const client = new HistoryClient();
  const backend = new ITerm2Backend(client as never, createLogger({ stdout: false }), {
    minMs: 60_000,
  });
  await backend.connect();
  return { client, backend };
}

function request(
  capture: HistoryCapture,
  overrides: Partial<HistoryReadRequest> = {},
): HistoryReadRequest {
  return {
    capture,
    reported: 10,
    before: 10,
    count: 2,
    signal: new AbortController().signal,
    ...overrides,
  };
}

describe("iTerm capture-owned history", () => {
  it("keeps default and false screen reads to the original buffer RPC", async () => {
    const { backend, client } = await fixture();
    try {
      expect((await backend.getScreen("S1")).historyCapture).toBeUndefined();
      expect((await backend.getScreen("S1", { history: false })).historyCapture).toBeUndefined();
      expect(client.nativeCalls.map((call) => call.case)).toEqual([
        "getBufferRequest",
        "getBufferRequest",
      ]);
    } finally {
      await backend.close();
    }
  });

  it("captures an exact two-row viewport and reads the physical rows [8,10)", async () => {
    const { backend, client } = await fixture();
    try {
      const screen = await backend.getScreen("S1", { history: true });
      expect(screen.historyCapture).toBeDefined();
      expect(Object.isFrozen(screen.historyCapture)).toBe(true);
      expect(screen.scrollbackTotal).toBe(10);
      expect(client.nativeCalls.map((call) => call.case)).toEqual([
        "getPropertyRequest",
        "getBufferRequest",
        "getPropertyRequest",
      ]);
      const page = await backend.getHistoryPage("S1", request(screen.historyCapture!));
      expect(page).toMatchObject({
        status: "page",
        from: 8,
        to: 10,
        oldestAvailable: 7,
        lines: [{ r: [{ t: "row-8" }] }, { r: [{ t: "row-9" }] }],
      });
      const native = client.nativeCalls[4];
      expect(native?.case).toBe("getBufferRequest");
      if (native?.case !== "getBufferRequest") throw new Error("missing bounded request");
      expect(native.value).toMatchObject({
        session: "S1",
        includeStyles: true,
        lineRange: {
          windowedCoordRange: { coordRange: { start: { x: 0, y: 8n }, end: { x: 0, y: 10n } } },
        },
      });
      const property = client.nativeCalls[0];
      expect(property?.case).toBe("getPropertyRequest");
      if (property?.case !== "getPropertyRequest") throw new Error("missing facts request");
      expect(property.value).toMatchObject({
        identifier: { case: "sessionId", value: "S1" },
        name: "number_of_lines",
      });
    } finally {
      await backend.close();
    }
  });

  it.each([0, 2])("keeps the live screen when property command %i fails", async (stage) => {
    const { backend, client } = await fixture();
    try {
      client.alter = (_, index) => {
        if (index === stage) throw new Error("property unavailable");
      };
      const screen = await backend.getScreen("S1", { history: true });
      expect(screen.lines.map((line) => line.r.map((run) => run.t).join(""))).toEqual([
        "row-10",
        "row-11",
      ]);
      expect(screen.historyCapture).toBeUndefined();
    } finally {
      await backend.close();
    }
  });

  it.each([
    "malformed",
    "non-ok-property",
    "short",
    "extra",
    "wrong-range",
    "columns",
    "window",
    "grid",
    "unsafe-end",
  ])("omits capture when native evidence is %s", async (fault) => {
    const { backend, client } = await fixture();
    try {
      if (fault === "grid") client.facts.grid = 3;
      if (fault === "unsafe-end") {
        client.facts.overflow = Number.MAX_SAFE_INTEGER - 1;
        client.facts.history = 0;
      }
      client.alter = (reply) => {
        if (reply.submessage.case === "getPropertyResponse") {
          if (fault === "malformed") reply.submessage.value.jsonValue = "{}";
          if (fault === "non-ok-property") reply.submessage.value.status = 1;
        }
        if (reply.submessage.case === "getBufferResponse") {
          const buffer = reply.submessage.value;
          if (fault === "short") buffer.contents.pop();
          if (fault === "extra") buffer.contents.push(create(LineContentsSchema));
          if (fault === "wrong-range") buffer.windowedCoordRange!.coordRange!.start!.y = 9n;
          if (fault === "columns") buffer.windowedCoordRange!.coordRange!.start!.x = 1;
          if (fault === "window")
            buffer.windowedCoordRange!.columns = create(RangeSchema, { location: 0n, length: 80n });
        }
      };
      expect((await backend.getScreen("S1", { history: true })).historyCapture).toBeUndefined();
    } finally {
      await backend.close();
    }
  });

  it.each(
    [0, 1, 2].flatMap((stage) =>
      ["output", "layout", "disconnect"].map((change) => ({ stage, change })),
    ),
  )(
    "never stamps a later revision on a capture after $change at command $stage",
    async ({ stage, change }) => {
      const { backend, client } = await fixture();
      try {
        client.alter = (_, index) => {
          if (index !== stage) return;
          if (change === "output") output(client);
          if (change === "layout") relayout(client);
          if (change === "disconnect") disconnect(client);
        };
        expect((await backend.getScreen("S1", { history: true })).historyCapture).toBeUndefined();
      } finally {
        await backend.close();
      }
    },
  );

  it("pages to proven end and distinguishes a cursor older than retention", async () => {
    const { backend, client } = await fixture();
    try {
      const capture = (await backend.getScreen("S1", { history: true })).historyCapture!;
      expect(await backend.getHistoryPage("S1", request(capture))).toMatchObject({
        status: "page",
        from: 8,
        to: 10,
      });
      expect(await backend.getHistoryPage("S1", request(capture, { before: 8 }))).toMatchObject({
        status: "page",
        from: 7,
        to: 8,
      });
      client.nativeCalls = [];
      expect(await backend.getHistoryPage("S1", request(capture, { before: 7 }))).toEqual({
        status: "boundary",
        reason: "end",
        oldestAvailable: 7,
      });
      expect(await backend.getHistoryPage("S1", request(capture, { before: 6 }))).toEqual({
        status: "boundary",
        reason: "truncated",
        oldestAvailable: 7,
      });
      expect(client.nativeCalls.map((call) => call.case)).toEqual(
        Array(4).fill("getPropertyRequest"),
      );
    } finally {
      await backend.close();
    }
  });

  it("rejects foreign/session/origin anchors without revoking valid captures", async () => {
    const { backend, client } = await fixture();
    const other = await fixture();
    try {
      const capture = (await backend.getScreen("S1", { history: true })).historyCapture!;
      const foreign = (await other.backend.getScreen("S1", { history: true })).historyCapture!;
      client.nativeCalls = [];
      for (const [session, req] of [
        ["S1", request(foreign)],
        ["S2", request(capture)],
        ["S1", request(capture, { reported: 11 })],
      ] as const)
        expect(await backend.getHistoryPage(session, req)).toEqual({
          status: "unavailable",
          reason: "unanchored",
        });
      expect(client.nativeCalls).toHaveLength(0);
      expect(await backend.getHistoryPage("S1", request(capture))).toMatchObject({
        status: "page",
      });
      await expect(backend.getHistoryPage("gone", request(capture))).rejects.toBeInstanceOf(
        SessionGone,
      );
      await expect(backend.getScreen("gone", { history: true })).rejects.toBeInstanceOf(
        SessionGone,
      );
    } finally {
      await backend.close();
      await other.backend.close();
    }
  });

  it("keeps absolute captures across output, scrolling, and unchanged boot materialization", async () => {
    const { backend, client } = await fixture();
    try {
      const capture = (await backend.getScreen("S1", { history: true })).historyCapture!;
      output(client);
      client.facts.history = 5;
      client.facts.first_visible = 8;
      await backend.connect();
      expect(await backend.getHistoryPage("S1", request(capture))).toMatchObject({
        status: "page",
        from: 8,
        to: 10,
      });
      client.alter = (_, index) => {
        if (index === client.nativeCalls.length - 1) client.facts.first_visible++;
      };
      expect(await backend.getHistoryPage("S1", request(capture))).toMatchObject({
        status: "page",
        from: 8,
      });
    } finally {
      await backend.close();
    }
  });

  it.each(
    [0, 1, 2].flatMap((stage) => ["activity", "progress"].map((change) => ({ stage, change }))),
  )(
    "rejects $change during read command $stage, then allows a stable retry",
    async ({ stage, change }) => {
      const { backend, client } = await fixture();
      try {
        const capture = (await backend.getScreen("S1", { history: true })).historyCapture!;
        client.nativeCalls = [];
        client.alter = (reply, index) => {
          if (index !== stage) return;
          if (change === "activity") output(client);
          else {
            client.facts.history++;
            if (reply.submessage.case === "getPropertyResponse")
              reply.submessage.value.jsonValue = JSON.stringify(client.facts);
          }
        };
        // Progress already visible in the first facts read is a valid current bracket.
        const result = await backend.getHistoryPage("S1", request(capture));
        expect(result).toMatchObject(
          change === "progress" && stage === 0
            ? { status: "page" }
            : { status: "unavailable", reason: "changed" },
        );
        client.alter = undefined;
        expect(await backend.getHistoryPage("S1", request(capture))).toMatchObject({
          status: "page",
        });
      } finally {
        await backend.close();
      }
    },
  );

  it("uses advancing retention bounds, including overflow beyond the old origin", async () => {
    const { backend, client } = await fixture();
    try {
      const capture = (await backend.getScreen("S1", { history: true })).historyCapture!;
      client.facts.overflow = 9;
      expect(await backend.getHistoryPage("S1", request(capture))).toMatchObject({
        status: "page",
        from: 9,
        to: 10,
        oldestAvailable: 9,
      });
      client.facts.overflow = 11;
      expect(await backend.getHistoryPage("S1", request(capture))).toEqual({
        status: "boundary",
        reason: "truncated",
        oldestAvailable: 11,
      });
    } finally {
      await backend.close();
    }
  });

  it.each([0, 2].flatMap((stage) => ["overflow", "origin"].map((field) => ({ stage, field }))))(
    "revokes the epoch for $field regression in facts command $stage",
    async ({ stage, field }) => {
      const { backend, client } = await fixture();
      try {
        const capture = (await backend.getScreen("S1", { history: true })).historyCapture!;
        client.nativeCalls = [];
        client.alter = (reply, index) => {
          if (index === stage && reply.submessage.case === "getPropertyResponse")
            reply.submessage.value.jsonValue = JSON.stringify({
              ...client.facts,
              ...(field === "overflow" ? { overflow: 6, history: 4 } : { history: 2 }),
            });
        };
        expect(await backend.getHistoryPage("S1", request(capture))).toEqual({ status: "reset" });
        client.alter = undefined;
        client.nativeCalls = [];
        expect(await backend.getHistoryPage("S1", request(capture))).toEqual({ status: "reset" });
        expect(client.nativeCalls).toHaveLength(0);
        const fresh = (await backend.getScreen("S1", { history: true })).historyCapture!;
        expect(await backend.getHistoryPage("S1", request(fresh))).toMatchObject({
          status: "page",
        });
      } finally {
        await backend.close();
      }
    },
  );

  it.each(
    [0, 1, 2].flatMap((stage) =>
      ["abort", "layout", "remove", "disconnect", "close", "abort-and-layout"].map((change) => ({
        stage,
        change,
      })),
    ),
  )("stops after command $stage on $change", async ({ stage, change }) => {
    const { backend, client } = await fixture();
    try {
      const capture = (await backend.getScreen("S1", { history: true })).historyCapture!;
      const controller = new AbortController();
      client.nativeCalls = [];
      client.alter = async (_, index) => {
        if (index !== stage) return;
        if (change.includes("abort")) controller.abort();
        if (change.includes("layout")) relayout(client);
        if (change === "remove") remove(client);
        if (change === "disconnect") disconnect(client);
        if (change === "close") await backend.close();
      };
      expect(
        await backend.getHistoryPage("S1", request(capture, { signal: controller.signal })),
      ).toEqual({ status: change.includes("abort") ? "cancelled" : "reset" });
      expect(client.nativeCalls).toHaveLength(stage + 1);
    } finally {
      await backend.close();
    }
  });

  it.each([
    "short",
    "extra",
    "range",
    "column",
    "window",
    "missing-range",
    "unsafe-range",
    "wrong-message",
    "status",
    "reject",
  ])("never repairs %s range evidence into a page", async (fault) => {
    const { backend, client } = await fixture();
    try {
      const capture = (await backend.getScreen("S1", { history: true })).historyCapture!;
      client.nativeCalls = [];
      client.alter = (reply) => {
        if (reply.submessage.case !== "getBufferResponse") return;
        const buffer = reply.submessage.value;
        if (fault === "short") buffer.contents.pop();
        if (fault === "extra") buffer.contents.push(create(LineContentsSchema));
        if (fault === "range") buffer.windowedCoordRange!.coordRange!.end!.y = 11n;
        if (fault === "column") buffer.windowedCoordRange!.coordRange!.end!.x = 1;
        if (fault === "window")
          buffer.windowedCoordRange!.columns = create(RangeSchema, { location: 1n, length: 1n });
        if (fault === "missing-range") buffer.windowedCoordRange = undefined;
        if (fault === "unsafe-range")
          buffer.windowedCoordRange!.coordRange!.end!.y = BigInt(Number.MAX_SAFE_INTEGER) + 1n;
        if (fault === "wrong-message")
          reply.submessage = {
            case: "getPropertyResponse",
            value: create(GetPropertyResponseSchema),
          };
        if (fault === "status") buffer.status = 1;
        if (fault === "reject") throw new Error("range failed");
      };
      expect(await backend.getHistoryPage("S1", request(capture))).toEqual({
        status: "unavailable",
        reason: "changed",
      });
    } finally {
      await backend.close();
    }
  });

  it.each(
    [0, 2].flatMap((stage) =>
      ["malformed", "status", "reject", "grid"].map((fault) => ({ stage, fault })),
    ),
  )("treats $fault facts at command $stage as changed, not end", async ({ stage, fault }) => {
    const { backend, client } = await fixture();
    try {
      const capture = (await backend.getScreen("S1", { history: true })).historyCapture!;
      client.nativeCalls = [];
      client.alter = (reply, index) => {
        if (index !== stage || reply.submessage.case !== "getPropertyResponse") return;
        if (fault === "malformed") reply.submessage.value.jsonValue = "{}";
        if (fault === "status") reply.submessage.value.status = 1;
        if (fault === "reject") throw new Error("facts failed");
        if (fault === "grid")
          reply.submessage.value.jsonValue = JSON.stringify({ ...client.facts, grid: 3 });
      };
      expect(await backend.getHistoryPage("S1", request(capture))).toEqual({
        status: fault === "grid" ? "reset" : "unavailable",
        ...(fault === "grid" ? {} : { reason: "changed" }),
      });
    } finally {
      await backend.close();
    }
  });

  it("preserves blank and styled physical rows without padding history", async () => {
    const { backend, client } = await fixture();
    try {
      const capture = (await backend.getScreen("S1", { history: true })).historyCapture!;
      client.alter = (reply) => {
        if (reply.submessage.case !== "getBufferResponse") return;
        reply.submessage.value.contents = [
          create(LineContentsSchema, { text: "" }),
          create(LineContentsSchema, {
            text: "red",
            style: [
              create(CellStyleSchema, {
                fgColor: { case: "fgStandard", value: 1 },
                bold: true,
                repeats: 3,
              }),
            ],
          }),
        ];
      };
      expect(await backend.getHistoryPage("S1", request(capture))).toEqual({
        status: "page",
        from: 8,
        to: 10,
        oldestAvailable: 7,
        lines: [{ r: [] }, { r: [{ t: "red", fg: 1, b: true }] }],
      });
    } finally {
      await backend.close();
    }
  });

  it.each(["reconnect", "recreate"])(
    "rejects an old capture after same-ID %s without native queries",
    async (change) => {
      const { backend, client } = await fixture();
      try {
        const capture = (await backend.getScreen("S1", { history: true })).historyCapture!;
        if (change === "reconnect") {
          disconnect(client);
          await backend.connect();
        } else {
          remove(client);
          relayout(client);
        }
        client.nativeCalls = [];
        expect(await backend.getHistoryPage("S1", request(capture))).toEqual({ status: "reset" });
        expect(client.nativeCalls).toHaveLength(0);
        const fresh = (await backend.getScreen("S1", { history: true })).historyCapture!;
        expect(await backend.getHistoryPage("S1", request(fresh))).toMatchObject({
          status: "page",
        });
      } finally {
        await backend.close();
      }
    },
  );

  it("invalidates before new-session layout metadata completes", async () => {
    const { backend, client } = await fixture();
    const started = deferred();
    const release = deferred();
    try {
      const capture = (await backend.getScreen("S1", { history: true })).historyCapture!;
      client.beforeOther = async (sub) => {
        if (sub.case === "variableRequest" && sub.value.scope.value === "S4") {
          started.resolve();
          await release.promise;
        }
      };
      const next = layout();
      const first = next.windows[0]!.tabs[0]!.root!.links[0]!.child;
      const second = next.windows[0]!.tabs[0]!.root!.links[1]!.child;
      if (first.case === "session") first.value.gridSize!.height = 2;
      if (second.case === "session") second.value.uniqueIdentifier = "S4";
      client.emit(
        "notification",
        create(NotificationSchema, {
          layoutChangedNotification: create(LayoutChangedNotificationSchema, {
            listSessionsResponse: next,
          }),
        }),
      );
      await started.promise;
      client.nativeCalls = [];
      expect(await backend.getHistoryPage("S1", request(capture))).toEqual({ status: "reset" });
      expect(client.nativeCalls).toHaveLength(0);
    } finally {
      release.resolve();
      await backend.close();
    }
  });

  it.each(["reconnect", "recreate"])(
    "stale regressed facts cannot revoke a %s replacement",
    async (change) => {
      const { backend, client } = await fixture();
      const started = deferred();
      const release = deferred();
      let pending: Promise<unknown> | undefined;
      try {
        const capture = (await backend.getScreen("S1", { history: true })).historyCapture!;
        client.nativeCalls = [];
        client.alter = async (reply, index) => {
          if (index !== 0 || reply.submessage.case !== "getPropertyResponse") return;
          reply.submessage.value.jsonValue = JSON.stringify({ ...client.facts, overflow: 6 });
          started.resolve();
          await release.promise;
        };
        pending = backend.getHistoryPage("S1", request(capture));
        await started.promise;
        client.alter = undefined;
        if (change === "reconnect") {
          disconnect(client);
          await backend.connect();
        } else {
          remove(client);
          relayout(client);
        }
        const fresh = (await backend.getScreen("S1", { history: true })).historyCapture!;
        release.resolve();
        expect(await pending).toEqual({ status: "reset" });
        expect(await backend.getHistoryPage("S1", request(fresh))).toMatchObject({
          status: "page",
        });
      } finally {
        release.resolve();
        await pending;
        await backend.close();
      }
    },
  );

  it.each(
    [0, 1].flatMap((stage) =>
      ["page", "end", "truncated"].flatMap((kind) =>
        ["abort", "layout", "both"].map((change) => ({ stage, kind, change })),
      ),
    ),
  )(
    "checks caller ownership after helper $stage for $kind on $change",
    async ({ stage, kind, change }) => {
      const { backend, client } = await fixture();
      let spy: ReturnType<typeof inFactsContinuation> | undefined;
      try {
        const capture = (await backend.getScreen("S1", { history: true })).historyCapture!;
        const controller = new AbortController();
        client.nativeCalls = [];
        spy = inFactsContinuation(backend, stage, () => {
          if (change !== "layout") controller.abort();
          if (change !== "abort") relayout(client);
        });
        expect(
          await backend.getHistoryPage(
            "S1",
            request(capture, {
              before: kind === "page" ? 10 : kind === "end" ? 7 : 6,
              signal: controller.signal,
            }),
          ),
        ).toEqual({ status: change === "layout" ? "reset" : "cancelled" });
        expect(client.nativeCalls).toHaveLength(stage === 0 ? 1 : kind === "page" ? 3 : 2);
      } finally {
        spy?.mockRestore();
        await backend.close();
      }
    },
  );

  it.each(
    [0, 1].flatMap((stage) =>
      ["output", "layout", "disconnect"].map((change) => ({ stage, change })),
    ),
  )("cannot mint capture after helper $stage on $change", async ({ stage, change }) => {
    const { backend, client } = await fixture();
    const spy = inFactsContinuation(backend, stage, () => {
      if (change === "output") output(client);
      if (change === "layout") relayout(client);
      if (change === "disconnect") disconnect(client);
    });
    try {
      expect((await backend.getScreen("S1", { history: true })).historyCapture).toBeUndefined();
    } finally {
      spy.mockRestore();
      await backend.close();
    }
  });

  it.each(
    [6, 7].flatMap((before) =>
      [0, 1].flatMap((stage) =>
        [
          "abort",
          "layout",
          "disconnect",
          "remove",
          "both",
          "malformed",
          "status",
          "reject",
          "progress",
          "activity",
          "regression",
        ].map((change) => ({ before, stage, change })),
      ),
    ),
  )(
    "protects boundary before=$before at command $stage on $change",
    async ({ before, stage, change }) => {
      const { backend, client } = await fixture();
      try {
        const capture = (await backend.getScreen("S1", { history: true })).historyCapture!;
        const controller = new AbortController();
        client.nativeCalls = [];
        client.alter = (reply, index) => {
          if (index !== stage) return;
          if (change === "abort" || change === "both") controller.abort();
          if (change === "layout" || change === "both") relayout(client);
          if (change === "disconnect") disconnect(client);
          if (change === "remove") remove(client);
          if (change === "activity") output(client);
          if (change === "reject") throw new Error("property failed");
          if (reply.submessage.case !== "getPropertyResponse") return;
          if (change === "malformed") reply.submessage.value.jsonValue = "null";
          if (change === "status") reply.submessage.value.status = 1;
          if (change === "regression")
            reply.submessage.value.jsonValue = JSON.stringify({ ...client.facts, overflow: 6 });
          if (change === "progress") {
            client.facts.history++;
            if (stage === 1) reply.submessage.value.jsonValue = JSON.stringify(client.facts);
          }
        };
        const result = await backend.getHistoryPage(
          "S1",
          request(capture, { before, signal: controller.signal }),
        );
        const want =
          change === "abort" || change === "both"
            ? { status: "cancelled" }
            : ["layout", "disconnect", "remove", "regression"].includes(change)
              ? { status: "reset" }
              : { status: "unavailable", reason: "changed" };
        expect(result).toEqual(want);
        expect(client.nativeCalls.every((call) => call.case === "getPropertyRequest")).toBe(true);
        expect(client.nativeCalls).toHaveLength(
          stage === 0 && !["progress", "activity"].includes(change) ? 1 : 2,
        );
        if (change === "regression") {
          client.alter = undefined;
          client.nativeCalls = [];
          expect(await backend.getHistoryPage("S1", request(capture, { before }))).toEqual({
            status: "reset",
          });
          expect(client.nativeCalls).toHaveLength(0);
        }
      } finally {
        await backend.close();
      }
    },
  );

  it.each([
    { count: 0 },
    { count: 201 },
    { count: 1.5 },
    { before: -1 },
    { before: 11 },
    { reported: Number.MAX_SAFE_INTEGER + 1 },
    { before: Number.NaN },
    { capture: null as never },
  ])("rejects invalid admission %j before all native commands", async (invalid) => {
    const { backend, client } = await fixture();
    try {
      const controller = new AbortController();
      controller.abort();
      await expect(
        backend.getHistoryPage("gone", request({}, { ...invalid, signal: controller.signal })),
      ).rejects.toBeInstanceOf(RangeError);
      expect(client.nativeCalls).toHaveLength(0);
    } finally {
      await backend.close();
    }
  });

  it("honors pre-abort before missing-session admission", async () => {
    const { backend, client } = await fixture();
    try {
      const controller = new AbortController();
      controller.abort();
      expect(
        await backend.getHistoryPage("gone", request({}, { signal: controller.signal })),
      ).toEqual({ status: "cancelled" });
      expect(client.nativeCalls).toHaveLength(0);
    } finally {
      await backend.close();
    }
  });

  it.each([1_000_000, Number.MAX_SAFE_INTEGER - 2])(
    "requests only 200 physical rows from retained origin %i",
    async (origin) => {
      const { backend, client } = await fixture();
      try {
        client.facts = { overflow: 7, history: origin - 7, grid: 2, first_visible: origin };
        const capture = (await backend.getScreen("S1", { history: true })).historyCapture!;
        expect(capture).toBeDefined();
        client.nativeCalls = [];
        const page = await backend.getHistoryPage(
          "S1",
          request(capture, { before: origin, reported: origin, count: 200 }),
        );
        expect(page).toMatchObject({
          status: "page",
          from: origin - 200,
          to: origin,
          oldestAvailable: 7,
        });
        if (page.status !== "page") throw new Error("missing page");
        expect(page.lines).toHaveLength(200);
        expect(client.nativeCalls.map((call) => call.case)).toEqual([
          "getPropertyRequest",
          "getBufferRequest",
          "getPropertyRequest",
        ]);
        const buffer = client.nativeCalls[1];
        if (buffer?.case !== "getBufferRequest") throw new Error("missing bounded capture");
        expect(buffer.value.lineRange?.windowedCoordRange?.coordRange).toMatchObject({
          start: { x: 0, y: BigInt(origin - 200) },
          end: { x: 0, y: BigInt(origin) },
        });
      } finally {
        await backend.close();
      }
    },
  );

  it.each(["overflow", "origin"])(
    "revokes sequential %s regression still above the captured facts",
    async (field) => {
      const { backend, client } = await fixture();
      try {
        const capture = (await backend.getScreen("S1", { history: true })).historyCapture!;
        client.facts.overflow = 9;
        client.facts.history = 4;
        expect(await backend.getHistoryPage("S1", request(capture))).toMatchObject({
          status: "page",
        });
        if (field === "overflow") {
          client.facts.overflow = 8;
          client.facts.history = 5;
        } else client.facts.history = 3;
        expect(await backend.getHistoryPage("S1", request(capture))).toEqual({ status: "reset" });
        client.facts.overflow = 9;
        client.facts.history = 4;
        client.nativeCalls = [];
        expect(await backend.getHistoryPage("S1", request(capture))).toEqual({ status: "reset" });
        expect(client.nativeCalls).toHaveLength(0);
      } finally {
        await backend.close();
      }
    },
  );

  it("does not compare an older concurrent attempt to observations committed after it began", async () => {
    const { backend, client } = await fixture();
    const started = deferred();
    const release = deferred();
    let oldRead: Promise<unknown> | undefined;
    try {
      const capture = (await backend.getScreen("S1", { history: true })).historyCapture!;
      client.facts.overflow = 8;
      client.nativeCalls = [];
      client.alter = async (_, index) => {
        if (index === 2) {
          started.resolve();
          await release.promise;
        }
      };
      oldRead = backend.getHistoryPage("S1", request(capture));
      await started.promise;
      client.alter = undefined;
      client.facts.overflow = 9;
      expect(await backend.getHistoryPage("S1", request(capture))).toMatchObject({
        status: "page",
        oldestAvailable: 9,
      });
      release.resolve();
      expect(await oldRead).toMatchObject({ status: "page", oldestAvailable: 8 });
      client.facts.overflow = 8;
      expect(await backend.getHistoryPage("S1", request(capture))).toEqual({ status: "reset" });
      client.facts.overflow = 9;
      client.nativeCalls = [];
      expect(await backend.getHistoryPage("S1", request(capture))).toEqual({ status: "reset" });
      expect(client.nativeCalls).toHaveLength(0);
    } finally {
      release.resolve();
      await oldRead;
      await backend.close();
    }
  });

  it("a regressed opt-in screen revokes prior captures while preserving live rows", async () => {
    const { backend, client } = await fixture();
    try {
      const capture = (await backend.getScreen("S1", { history: true })).historyCapture!;
      client.facts.overflow = 6;
      const regressed = await backend.getScreen("S1", { history: true });
      expect(regressed.lines).toHaveLength(2);
      expect(regressed.historyCapture).toBeUndefined();
      client.facts.overflow = 7;
      client.nativeCalls = [];
      expect(await backend.getHistoryPage("S1", request(capture))).toEqual({ status: "reset" });
      expect(client.nativeCalls).toHaveLength(0);
      const fresh = (await backend.getScreen("S1", { history: true })).historyCapture!;
      expect(await backend.getHistoryPage("S1", request(fresh))).toMatchObject({ status: "page" });
    } finally {
      await backend.close();
    }
  });

  it.each(["malformed", "status", "grid", "progress", "regression"])(
    "rejects %s final capture facts",
    async (change) => {
      const { backend, client } = await fixture();
      try {
        const old = (await backend.getScreen("S1", { history: true })).historyCapture!;
        client.nativeCalls = [];
        client.alter = (reply, index) => {
          if (index !== 2 || reply.submessage.case !== "getPropertyResponse") return;
          if (change === "status") reply.submessage.value.status = 1;
          else
            reply.submessage.value.jsonValue =
              change === "malformed"
                ? "{}"
                : JSON.stringify({
                    ...client.facts,
                    ...(change === "grid"
                      ? { grid: 3 }
                      : change === "progress"
                        ? { history: 4 }
                        : { overflow: 6 }),
                  });
        };
        expect((await backend.getScreen("S1", { history: true })).historyCapture).toBeUndefined();
        client.alter = undefined;
        client.nativeCalls = [];
        if (change === "regression" || change === "grid") {
          expect(await backend.getHistoryPage("S1", request(old))).toEqual({ status: "reset" });
          expect(client.nativeCalls).toHaveLength(0);
        } else
          expect(await backend.getHistoryPage("S1", request(old))).toMatchObject({
            status: "page",
          });
      } finally {
        await backend.close();
      }
    },
  );

  it("does not certify high-water facts from an activity-contended read", async () => {
    const { backend, client } = await fixture();
    try {
      const capture = (await backend.getScreen("S1", { history: true })).historyCapture!;
      client.facts.overflow = 9;
      client.nativeCalls = [];
      client.alter = (_, index) => {
        if (index === 1) output(client);
      };
      expect(await backend.getHistoryPage("S1", request(capture))).toEqual({
        status: "unavailable",
        reason: "changed",
      });
      client.alter = undefined;
      client.facts.overflow = 8;
      expect(await backend.getHistoryPage("S1", request(capture))).toMatchObject({
        status: "page",
        oldestAvailable: 8,
      });
    } finally {
      await backend.close();
    }
  });

  it.each([0, 1, 2])("cancellation wins a rejected RPC at command %i", async (stage) => {
    const { backend, client } = await fixture();
    try {
      const capture = (await backend.getScreen("S1", { history: true })).historyCapture!;
      const controller = new AbortController();
      client.nativeCalls = [];
      client.alter = (_, index) => {
        if (index !== stage) return;
        relayout(client);
        controller.abort();
        throw new Error("cancelled native RPC");
      };
      expect(
        await backend.getHistoryPage("S1", request(capture, { signal: controller.signal })),
      ).toEqual({ status: "cancelled" });
      expect(client.nativeCalls).toHaveLength(stage + 1);
    } finally {
      await backend.close();
    }
  });

  it("scrolling during capture does not change the absolute origin", async () => {
    const { backend, client } = await fixture();
    try {
      client.alter = (_, index) => {
        if (index === 1) client.facts.first_visible = 8;
      };
      const screen = await backend.getScreen("S1", { history: true });
      expect(screen.historyCapture).toBeDefined();
      expect(screen.scrollbackTotal).toBe(10);
      client.alter = undefined;
      expect(await backend.getHistoryPage("S1", request(screen.historyCapture!))).toMatchObject({
        status: "page",
        from: 8,
        to: 10,
      });
    } finally {
      await backend.close();
    }
  });

  it("uses the acknowledged capture origin after a newer screen capture exists", async () => {
    const { backend, client } = await fixture();
    try {
      const old = (await backend.getScreen("S1", { history: true })).historyCapture!;
      output(client);
      client.facts.history = 5;
      const latest = await backend.getScreen("S1", { history: true });
      expect(latest.scrollbackTotal).toBe(12);
      expect(latest.historyCapture).toBeDefined();
      expect(await backend.getHistoryPage("S1", request(old))).toMatchObject({
        status: "page",
        from: 8,
        to: 10,
      });
      expect(await backend.getHistoryPage("S1", request(old, { reported: 12 }))).toEqual({
        status: "unavailable",
        reason: "unanchored",
      });
    } finally {
      await backend.close();
    }
  });

  it("initial capture grid contradiction revokes the epoch without losing live rows", async () => {
    const { backend, client } = await fixture();
    try {
      const old = (await backend.getScreen("S1", { history: true })).historyCapture!;
      client.nativeCalls = [];
      client.alter = (reply, index) => {
        if (index === 0 && reply.submessage.case === "getPropertyResponse")
          reply.submessage.value.jsonValue = JSON.stringify({ ...client.facts, grid: 3 });
      };
      const screen = await backend.getScreen("S1", { history: true });
      expect(screen.lines).toHaveLength(2);
      expect(screen.historyCapture).toBeUndefined();
      client.alter = undefined;
      client.nativeCalls = [];
      expect(await backend.getHistoryPage("S1", request(old))).toEqual({ status: "reset" });
      expect(client.nativeCalls).toHaveLength(0);
    } finally {
      await backend.close();
    }
  });

  it.each([0, 2])(
    "stale capture grid facts at command %i cannot revoke replacement ownership",
    async (stage) => {
      const { backend, client } = await fixture();
      const started = deferred();
      const release = deferred();
      let pending: ReturnType<ITerm2Backend["getScreen"]> | undefined;
      try {
        client.alter = async (reply, index) => {
          if (index !== stage || reply.submessage.case !== "getPropertyResponse") return;
          reply.submessage.value.jsonValue = JSON.stringify({ ...client.facts, grid: 3 });
          started.resolve();
          await release.promise;
        };
        pending = backend.getScreen("S1", { history: true });
        await started.promise;
        client.alter = undefined;
        disconnect(client);
        await backend.connect();
        const fresh = (await backend.getScreen("S1", { history: true })).historyCapture!;
        release.resolve();
        expect((await pending).historyCapture).toBeUndefined();
        expect(await backend.getHistoryPage("S1", request(fresh))).toMatchObject({
          status: "page",
        });
      } finally {
        release.resolve();
        await pending;
        await backend.close();
      }
    },
  );

  it.each(
    ["grid", "overflow", "origin"].flatMap((contradiction) =>
      ["rejected", "non-ok", "deferred"].map((buffer) => ({ contradiction, buffer })),
    ),
  )(
    "revokes initial $contradiction contradiction before a $buffer buffer completes",
    async ({ contradiction, buffer }) => {
      const { backend, client } = await fixture();
      const started = deferred();
      const release = deferred();
      const failure = new Error("buffer rejected after contradictory facts");
      let pending:
        | Promise<{ screen?: Awaited<ReturnType<ITerm2Backend["getScreen"]>>; error?: unknown }>
        | undefined;
      try {
        const old = (await backend.getScreen("S1", { history: true })).historyCapture!;
        client.nativeCalls = [];
        client.alter = async (reply, index) => {
          if (index === 0 && reply.submessage.case === "getPropertyResponse") {
            reply.submessage.value.jsonValue = JSON.stringify({
              ...client.facts,
              ...(contradiction === "grid"
                ? { grid: 3 }
                : contradiction === "overflow"
                  ? { overflow: 6, history: 4 }
                  : { history: 2 }),
            });
          }
          if (index !== 1 || reply.submessage.case !== "getBufferResponse") return;
          started.resolve();
          if (buffer === "rejected") throw failure;
          if (buffer === "non-ok") reply.submessage.value.status = 1;
          if (buffer === "deferred") await release.promise;
        };
        pending = backend.getScreen("S1", { history: true }).then(
          (screen) => ({ screen }),
          (error: unknown) => ({ error }),
        );
        await started.promise;
        if (buffer !== "deferred") {
          const result = await pending;
          if (buffer === "rejected") expect(result.error).toBe(failure);
          else expect(result.error).toBeInstanceOf(SessionGone);
        }
        // Restore valid native facts before retrying: only persistent epoch revocation
        // can reject this token without issuing another property/buffer request.
        client.alter = undefined;
        client.facts = { overflow: 7, history: 3, grid: 2, first_visible: 10 };
        client.nativeCalls = [];
        expect(await backend.getHistoryPage("S1", request(old))).toEqual({ status: "reset" });
        expect(client.nativeCalls).toHaveLength(0);
        release.resolve();
        if (buffer === "deferred") {
          const result = await pending;
          expect(result.error).toBeUndefined();
          expect(result.screen?.lines).toHaveLength(2);
          expect(result.screen?.historyCapture).toBeUndefined();
        }
      } finally {
        release.resolve();
        await pending;
        await backend.close();
      }
    },
  );

  it.each(["grid", "overflow", "origin"])(
    "stale initial %s facts and a rejected buffer cannot revoke replacement ownership",
    async (contradiction) => {
      const { backend, client } = await fixture();
      const started = deferred();
      const release = deferred();
      const failure = new Error("obsolete buffer failed");
      let pending: Promise<unknown> | undefined;
      try {
        await backend.getScreen("S1", { history: true });
        client.nativeCalls = [];
        client.alter = async (reply, index) => {
          if (index !== 0 || reply.submessage.case !== "getPropertyResponse") return;
          reply.submessage.value.jsonValue = JSON.stringify({
            ...client.facts,
            ...(contradiction === "grid"
              ? { grid: 3 }
              : contradiction === "overflow"
                ? { overflow: 6, history: 4 }
                : { history: 2 }),
          });
          started.resolve();
          await release.promise;
        };
        pending = backend.getScreen("S1", { history: true }).catch((error: unknown) => error);
        await started.promise;
        client.alter = undefined;
        disconnect(client);
        await backend.connect();
        const fresh = (await backend.getScreen("S1", { history: true })).historyCapture!;
        client.alter = (reply) => {
          if (reply.submessage.case === "getBufferResponse") throw failure;
        };
        release.resolve();
        expect(await pending).toBe(failure);
        client.alter = undefined;
        expect(await backend.getHistoryPage("S1", request(fresh))).toMatchObject({
          status: "page",
        });
      } finally {
        release.resolve();
        await pending;
        await backend.close();
      }
    },
  );
});
