import { describe, expect, it, vi } from "vitest";
import { HerdrBackend } from "../src/backends/herdr/backend.js";
import { HerdrClient, HerdrError, type HerdrStreamHandlers } from "../src/backends/herdr/client.js";
import type { HerdrEvent, HerdrSubscription } from "../src/backends/herdr/types.js";
import {
  type HistoryCapture,
  type HistoryReadRequest,
  SessionGone,
  type TerminalBackend,
} from "../src/backends/types.js";
import { createLogger } from "../src/log.js";
import { waitFor } from "./fakes/wait.js";

const log = createLogger({ stdout: false });
const paneInfo = () => ({
  pane_id: "p1",
  terminal_id: "t1",
  workspace_id: "w1",
  tab_id: "tab1",
  focused: true,
  agent_status: "idle",
  revision: 5,
  scroll: { offset_from_bottom: 0, max_offset_from_bottom: 3, viewport_rows: 2 },
});
const facts = () => ({ type: "pane_info", pane: paneInfo() });
const buffer = (source: string, text: string) => ({
  type: "pane_read",
  read: { pane_id: "p1", source, format: "ansi", revision: 0, truncated: false, text },
});

class SyntheticHerdr extends HerdrClient {
  calls: { method: string; params: Record<string, unknown> }[] = [];
  handlers: HerdrStreamHandlers | undefined;
  info = facts();
  snapshot = {
    type: "session_snapshot",
    snapshot: {
      version: "0.8.2",
      protocol: 1,
      workspaces: [],
      tabs: [],
      agents: [],
      panes: [paneInfo()],
      layouts: [
        {
          workspace_id: "w1",
          tab_id: "tab1",
          panes: [{ pane_id: "p1", rect: { x: 0, y: 0, width: 8, height: 2 } }],
        },
      ],
    },
  };
  visible = buffer("visible", "view A\nview B\n");
  recent = ["old", "\x1b[31mred\x1b[0m", "", "view A", "view B"];
  intercept?: (method: string, params: Record<string, unknown>) => Promise<unknown> | undefined;
  constructor() {
    super({ log });
  }
  override async ping() {
    return { type: "pong" as const, version: "0.8.2" };
  }
  override async subscribe(_subscriptions: HerdrSubscription[], handlers: HerdrStreamHandlers) {
    this.handlers = handlers;
    return { close() {} };
  }
  override async request<T>(method: string, params: Record<string, unknown>): Promise<T> {
    this.calls.push({ method, params });
    const pending = this.intercept?.(method, params);
    if (pending) return (await pending) as T;
    if (method === "session.snapshot") return structuredClone(this.snapshot) as T;
    if (method === "pane.get") return structuredClone(this.info) as T;
    if (method === "pane.read")
      return (
        params.source === "visible"
          ? this.visible
          : buffer("recent", `${this.recent.slice(-Number(params.lines)).join("\n")}\n`)
      ) as T;
    throw new Error(`unexpected ${method}`);
  }
  event(event: string, data: HerdrEvent["data"]) {
    this.handlers?.onEvent({ event, data });
  }
}

async function fixture() {
  const native = new SyntheticHerdr();
  const backend: TerminalBackend = new HerdrBackend({
    client: native,
    log,
    syncDebounceMs: 0,
    reconnectMs: 60_000,
  });
  await backend.connect();
  native.calls = [];
  return { native, backend };
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

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
async function capture(backend: TerminalBackend) {
  const token = (await backend.getScreen("t1", { history: true })).historyCapture;
  expect(token).toBeDefined();
  return token!;
}

it("pages physical history when Ghostty trims the same blank viewport tail from both reads", async () => {
  const { native, backend } = await fixture();
  try {
    native.visible = buffer("visible", "view A\n");
    native.recent = ["old", "\x1b[31mred\x1b[0m", "", "view A", ""];
    native.intercept = (method, params) =>
      method === "pane.read" && params.source === "recent"
        ? Promise.resolve(
            buffer(
              "recent",
              `${native.recent.slice(-Number(params.lines)).join("\n").replace(/\n+$/, "")}\n`,
            ),
          )
        : undefined;
    const token = await capture(backend);
    const page = await backend.getHistoryPage!("t1", request(token));
    expect(page).toMatchObject({ status: "page", from: 8, to: 10 });
    if (page.status !== "page") throw new Error("missing history");
    expect(page.lines).toEqual([{ r: [{ t: "red", fg: 1 }] }, { r: [] }]);
    // A different shortfall is not evidence of blank rows. Never pad older history.
    native.intercept = (method, params) =>
      method === "pane.read" && params.source === "recent"
        ? Promise.resolve(buffer("recent", "view A\n"))
        : undefined;
    expect(await backend.getHistoryPage!("t1", request(token))).toMatchObject({
      status: "unavailable",
    });
  } finally {
    await backend.close();
  }
});
async function revokedWithoutQuery(
  native: SyntheticHerdr,
  backend: TerminalBackend,
  token: HistoryCapture,
) {
  native.info = facts();
  native.intercept = undefined;
  native.calls = [];
  const result = await backend.getHistoryPage?.("t1", request(token));
  expect(native.calls).toEqual([]);
  expect(result).toEqual({ status: "reset" });
}

async function waitForAsync(condition: () => Promise<boolean>) {
  const deadline = Date.now() + 3000;
  while (!(await condition())) {
    if (Date.now() > deadline) throw new Error("condition did not become true");
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
}

describe("Herdr capture-owned history", () => {
  it("keeps legacy row indexing correct when the visible and recent ANSI tail is trimmed", async () => {
    const { native, backend } = await fixture();
    try {
      native.visible = buffer("visible", "view A\n");
      native.recent = ["old", "red", "", "view A", ""];
      native.intercept = (method, params) =>
        method === "pane.read" && params.source === "recent"
          ? Promise.resolve(
              buffer(
                "recent",
                `${native.recent.slice(-Number(params.lines)).join("\n").replace(/\n+$/, "")}\n`,
              ),
            )
          : undefined;
      expect((await backend.getScreen("t1")).scrollbackTotal).toBe(3);
      expect(await backend.getHistory("t1", 3, 2)).toEqual({
        lines: [{ r: [{ t: "red" }] }, { r: [] }],
        oldestAvailable: 0,
      });
    } finally {
      await backend.close();
    }
  });

  it("does not report a legacy end when the cursor lies beyond Herdr's native fetch window", async () => {
    const { native, backend } = await fixture();
    try {
      native.info.pane.scroll.max_offset_from_bottom = 2000;
      native.event("pane.scroll_changed", {
        pane_id: "p1",
        scroll: {
          offset_from_bottom: 0,
          max_offset_from_bottom: 2000,
          viewport_rows: 2,
        },
      });
      native.recent = Array.from({ length: 2002 }, (_, index) => `r${index}`);
      expect((await backend.getScreen("t1")).scrollbackTotal).toBe(2000);
      await expect(backend.getHistory("t1", 1000, 200)).rejects.toThrow();
    } finally {
      await backend.close();
    }
  });

  it.each(["different tail", "changed viewport"])(
    "refuses to infer legacy trimmed rows from a %s",
    async (flaw) => {
      const { native, backend } = await fixture();
      try {
        native.visible = buffer(
          "visible",
          flaw === "different tail" ? "view A\nview B\n" : "changed\n",
        );
        native.intercept = (method, params) =>
          method === "pane.read" && params.source === "recent"
            ? Promise.resolve(buffer("recent", "red\n\nview A\n"))
            : undefined;
        await expect(backend.getHistory("t1", 3, 2)).rejects.toMatchObject({
          name: "BackendUnavailable",
        });
      } finally {
        await backend.close();
      }
    },
  );

  it("keeps the legacy stale-scroll screen result when an unchanged snapshot lands during refresh", async () => {
    const { native, backend } = await fixture();
    try {
      native.event("pane.scroll_changed", { pane_id: "p1" });
      const pending = deferred<unknown>();
      let hit = false;
      native.intercept = (method) => {
        if (method === "pane.get") {
          hit = true;
          return pending.promise;
        }
      };
      const screen = backend.getScreen("t1");
      await waitFor(() => hit);
      // A completed authoritative refresh creates a new Pane object even when unchanged.
      await (backend as unknown as { refreshSnapshot(): Promise<void> }).refreshSnapshot();
      const fresh = facts();
      fresh.pane.scroll.max_offset_from_bottom = 6;
      pending.resolve(fresh);
      expect(await screen).toMatchObject({ scrollbackTotal: 6 });
    } finally {
      await backend.close();
    }
  });
  it("leaves default and false reads on the legacy visible-only path", async () => {
    const { native, backend } = await fixture();
    try {
      expect((await backend.getScreen("t1")).historyCapture).toBeUndefined();
      expect((await backend.getScreen("t1", { history: false })).historyCapture).toBeUndefined();
      expect(native.calls).toEqual(
        [0, 1].map(() => ({
          method: "pane.read",
          params: {
            pane_id: "p1",
            source: "visible",
            format: "ansi",
          },
        })),
      );
    } finally {
      await backend.close();
    }
  });

  it("brackets exact visible capture and maps an ACK-owned styled page into [8,10)", async () => {
    const { native, backend } = await fixture();
    try {
      const screen = await backend.getScreen("t1", { history: true });
      expect(screen.historyCapture).toBeDefined();
      expect(Object.isFrozen(screen.historyCapture)).toBe(true);
      expect(native.calls.map((c) => c.method)).toEqual(["pane.get", "pane.read", "pane.get"]);
      native.calls = [];
      const result = await backend.getHistoryPage?.("t1", request(screen.historyCapture!));
      expect(result).toEqual({
        status: "page",
        from: 8,
        to: 10,
        oldestAvailable: 7,
        lines: [{ r: [{ t: "red", fg: 1 }] }, { r: [] }],
      });
      expect(native.calls).toEqual([
        { method: "pane.get", params: { pane_id: "p1" } },
        {
          method: "pane.read",
          params: { pane_id: "p1", source: "recent", format: "ansi", lines: 4 },
        },
        { method: "pane.get", params: { pane_id: "p1" } },
      ]);
    } finally {
      await backend.close();
    }
  });

  it.each(["revision", "scroll", "layout", "lifecycle"])(
    "persistently revokes on a %s hint before reconciliation",
    async (change) => {
      const { native, backend } = await fixture();
      try {
        const token = await capture(backend);
        const pending = deferred<unknown>();
        native.intercept = (method) =>
          method === "session.snapshot" ? pending.promise : undefined;
        if (change === "revision")
          native.event("pane_updated", { pane: { ...paneInfo(), revision: 6 } });
        if (change === "scroll")
          native.event("pane.scroll_changed", { pane_id: "p1", scroll: { offset_from_bottom: 1 } });
        if (change === "layout") native.event("layout_updated", {});
        if (change === "lifecycle") native.event("pane_moved", { pane_id: "p1" });
        // Restore local geometry/revision through a normal snapshot too: loss of ownership persists.
        native.event("pane_agent_status_changed", { pane_id: "p1" });
        await waitFor(() => native.calls.some((c) => c.method === "session.snapshot"));
        await revokedWithoutQuery(native, backend, token);
        pending.resolve(native.snapshot);
        await revokedWithoutQuery(native, backend, token);
      } finally {
        await backend.close();
      }
    },
  );

  it("preserves unchanged snapshot ownership and ignores old revision replay", async () => {
    const { native, backend } = await fixture();
    try {
      const token = await capture(backend);
      native.event("pane_updated", {
        pane: { ...paneInfo(), revision: 4, scroll: { offset_from_bottom: 2 } },
      });
      native.event("pane_agent_status_changed", { pane_id: "p1" });
      await waitFor(() => native.calls.some((c) => c.method === "session.snapshot"));
      expect(await backend.getHistoryPage?.("t1", request(token))).toMatchObject({
        status: "page",
        from: 8,
      });
    } finally {
      await backend.close();
    }
  });

  for (const gap of ["initial", "read", "final"] as const) {
    it.each(["abort", "revision", "scroll", "stream", "replacement", "abort-and-revision"])(
      `${gap} gap: %s prevents later commands/publication`,
      async (change) => {
        const { native, backend } = await fixture();
        try {
          const token = await capture(backend);
          native.calls = [];
          const pending = deferred<unknown>();
          let gets = 0;
          let hit = false;
          native.intercept = (method, params) => {
            if (method === "pane.get") gets++;
            if (
              (gap === "initial" && method === "pane.get" && gets === 1) ||
              (gap === "read" && method === "pane.read" && params.source === "recent") ||
              (gap === "final" && method === "pane.get" && gets === 2)
            ) {
              hit = true;
              return pending.promise;
            }
          };
          const abort = new AbortController();
          const page = backend.getHistoryPage!("t1", request(token, { signal: abort.signal }));
          await waitFor(() => hit);
          if (change.startsWith("abort")) abort.abort();
          if (change.includes("revision"))
            native.event("pane_updated", { pane: { ...paneInfo(), revision: 6 } });
          if (change === "scroll")
            native.event("pane.scroll_changed", {
              pane_id: "p1",
              scroll: { offset_from_bottom: 1 },
            });
          if (change === "stream") native.handlers!.onEnd("eof");
          if (change === "replacement") {
            await backend.close();
            await backend.connect();
          }
          const count = native.calls.length;
          pending.resolve(gap === "read" ? buffer("recent", "red\n\nview A\nview B\n") : facts());
          expect(await page).toEqual({
            status: change.startsWith("abort") ? "cancelled" : "reset",
          });
          expect(native.calls).toHaveLength(count);
          if (!change.startsWith("abort")) {
            if (change === "stream") await backend.connect();
            await revokedWithoutQuery(native, backend, token);
          }
        } finally {
          await backend.close();
        }
      },
    );
  }

  for (const stage of ["initial", "final"] as const) {
    it.each(["revision", "history", "viewport", "offset", "paneId", "terminalId"])(
      `${stage} valid %s contradiction permanently revokes evidence`,
      async (field) => {
        const { native, backend } = await fixture();
        try {
          const token = await capture(backend);
          let gets = 0;
          native.intercept = (method) => {
            if (method !== "pane.get" || ++gets !== (stage === "initial" ? 1 : 2)) return;
            const changed = facts();
            if (field === "revision") changed.pane.revision = 6;
            if (field === "history") changed.pane.scroll.max_offset_from_bottom = 4;
            if (field === "viewport") changed.pane.scroll.viewport_rows = 3;
            if (field === "offset") changed.pane.scroll.offset_from_bottom = 1;
            if (field === "paneId") changed.pane.pane_id = "other";
            if (field === "terminalId") changed.pane.terminal_id = "other";
            return Promise.resolve(changed);
          };
          expect(await backend.getHistoryPage!("t1", request(token))).toEqual({ status: "reset" });
          await revokedWithoutQuery(native, backend, token);
        } finally {
          await backend.close();
        }
      },
    );
  }

  it.each(["reject", "non-ok", "deferred"])(
    "capture revokes certified contradiction before a %s visible buffer",
    async (outcome) => {
      const { native, backend } = await fixture();
      try {
        const token = await capture(backend);
        native.info.pane.scroll.max_offset_from_bottom = 4;
        const visible = deferred<unknown>();
        let hit = false;
        native.intercept = (method, params) => {
          if (method === "pane.read" && params.source === "visible") {
            hit = true;
            return visible.promise;
          }
        };
        const screen = backend.getScreen("t1", { history: true });
        // Observe rejection immediately so the intentionally rejected native read is handled.
        const settled = screen.then(
          (value) => ({ value }),
          (error) => ({ error }),
        );
        await waitFor(() => hit);
        await revokedWithoutQuery(native, backend, token);
        if (outcome === "reject") visible.reject(new HerdrError("unavailable", "synthetic"));
        else visible.resolve(outcome === "non-ok" ? { type: "error" } : native.visible);
        const result = await settled;
        if (outcome === "reject") expect(result).toHaveProperty("error");
        else {
          expect(result).toHaveProperty("value");
          if ("value" in result) expect(result.value.historyCapture).toBeUndefined();
        }
      } finally {
        await backend.close();
      }
    },
  );

  for (const stage of ["initial", "read", "final"] as const) {
    it.each(["malformed", "non-ok", "reject", "busy"])(
      `${stage} %s remains unavailable and preserves the capture`,
      async (failure) => {
        const { native, backend } = await fixture();
        try {
          const token = await capture(backend);
          let gets = 0;
          native.intercept = (method, params) => {
            if (method === "pane.get") gets++;
            const match =
              stage === "read"
                ? method === "pane.read" && params.source === "recent"
                : method === "pane.get" && gets === (stage === "initial" ? 1 : 2);
            if (!match) return;
            if (failure === "reject" || failure === "busy")
              return Promise.reject(
                new HerdrError(failure === "busy" ? "agent_not_idle" : "unavailable", "synthetic"),
              );
            return Promise.resolve(
              failure === "non-ok"
                ? { type: "error" }
                : { type: stage === "read" ? "pane_read" : "pane_info" },
            );
          };
          expect(await backend.getHistoryPage!("t1", request(token))).toEqual({
            status: "unavailable",
            reason: failure === "busy" ? "busy" : "changed",
          });
          native.intercept = undefined;
          expect(await backend.getHistoryPage!("t1", request(token))).toMatchObject({
            status: "page",
            from: 8,
          });
        } finally {
          await backend.close();
        }
      },
    );
  }

  it.each([
    [7, "end"],
    [6, "truncated"],
  ] as const)("publishes cursor %i as %s only after two stable facts", async (before, reason) => {
    const { native, backend } = await fixture();
    try {
      const token = await capture(backend);
      native.calls = [];
      expect(await backend.getHistoryPage!("t1", request(token, { before }))).toEqual({
        status: "boundary",
        reason,
        oldestAvailable: 7,
      });
      expect(native.calls.map((c) => c.method)).toEqual(["pane.get", "pane.get"]);
      let gets = 0;
      native.intercept = (method) => {
        if (method === "pane.get" && ++gets === 2) {
          const changed = facts();
          changed.pane.revision = 6;
          return Promise.resolve(changed);
        }
      };
      expect(await backend.getHistoryPage!("t1", request(token, { before }))).toEqual({
        status: "reset",
      });
      await revokedWithoutQuery(native, backend, token);
    } finally {
      await backend.close();
    }
  });

  it("refuses unsafe or unanchored coordinates without queries and allows a later valid retry", async () => {
    const { native, backend } = await fixture();
    try {
      const token = await capture(backend);
      native.calls = [];
      for (const overrides of [
        { reported: 2, before: 2 },
        { reported: Number.MAX_SAFE_INTEGER, before: 10 },
      ]) {
        expect(await backend.getHistoryPage!("t1", request(token, overrides))).toEqual({
          status: "unavailable",
          reason: "unanchored",
        });
      }
      expect(native.calls).toEqual([]);
      expect(await backend.getHistoryPage!("t1", request(token))).toMatchObject({
        status: "page",
        from: 8,
      });
      expect(
        await backend.getHistoryPage!(
          "t1",
          request(token, {
            reported: Number.MAX_SAFE_INTEGER - 2,
            before: Number.MAX_SAFE_INTEGER - 2,
          }),
        ),
      ).toMatchObject({
        status: "page",
        from: Number.MAX_SAFE_INTEGER - 4,
        to: Number.MAX_SAFE_INTEGER - 2,
        oldestAvailable: Number.MAX_SAFE_INTEGER - 5,
      });
    } finally {
      await backend.close();
    }
  });

  it("validates requests, pre-abort, foreign tokens, wrong sessions, and missing entry sessions before native acquisition", async () => {
    const { native, backend } = await fixture();
    const other = await fixture();
    try {
      const token = await capture(backend);
      const foreign = await capture(other.backend);
      native.calls = [];
      for (const overrides of [
        { count: 0 },
        { count: 201 },
        { count: 1.5 },
        { reported: -1 },
        { before: 11 },
        { before: NaN },
      ]) {
        await expect(
          backend.getHistoryPage!("t1", request(token, overrides)),
        ).rejects.toBeInstanceOf(RangeError);
      }
      const abort = new AbortController();
      abort.abort();
      expect(
        await backend.getHistoryPage!("missing", request(token, { signal: abort.signal })),
      ).toEqual({ status: "cancelled" });
      for (const unknown of [foreign, Object.freeze({})])
        expect(await backend.getHistoryPage!("t1", request(unknown))).toEqual({
          status: "unavailable",
          reason: "unanchored",
        });
      await expect(backend.getHistoryPage!("missing", request(token))).rejects.toBeInstanceOf(
        SessionGone,
      );
      await expect(backend.getScreen("missing", { history: true })).rejects.toBeInstanceOf(
        SessionGone,
      );
      expect(native.calls).toEqual([]);
      // Same backend, present second session: ownership is still bound to t1.
      native.snapshot.snapshot.panes.push({ ...paneInfo(), pane_id: "p2", terminal_id: "t2" });
      native.event("pane_created", { pane_id: "p2" });
      await waitForAsync(async () => (await backend.listSessions()).some((p) => p.id === "t2"));
      native.calls = [];
      expect(await backend.getHistoryPage!("t2", request(token))).toEqual({
        status: "unavailable",
        reason: "unanchored",
      });
      expect(native.calls).toEqual([]);
    } finally {
      await backend.close();
      await other.backend.close();
    }
  });

  it.each(["short", "extra", "trailing-blank-omitted", "wide", "pane", "source", "format"])(
    "refuses a %s native history buffer without fabricating a boundary",
    async (flaw) => {
      const { native, backend } = await fixture();
      try {
        const token = await capture(backend);
        const read = buffer("recent", "red\n\nview A\nview B\n");
        if (flaw === "short") read.read.text = "red\nview A\nview B\n";
        if (flaw === "extra") read.read.text = "old\nred\n\nview A\nview B\n";
        if (flaw === "trailing-blank-omitted") read.read.text = "red\n\n";
        if (flaw === "wide") read.read.text = "123456789\n\nview A\nview B\n";
        if (flaw === "pane") read.read.pane_id = "other";
        if (flaw === "source") read.read.source = "visible";
        if (flaw === "format") read.read.format = "plain";
        native.intercept = (method) => (method === "pane.read" ? Promise.resolve(read) : undefined);
        expect(await backend.getHistoryPage!("t1", request(token))).toEqual({
          status: "unavailable",
          reason: "changed",
        });
        native.intercept = undefined;
        expect(await backend.getHistoryPage!("t1", request(token))).toMatchObject({
          status: "page",
        });
      } finally {
        await backend.close();
      }
    },
  );

  it.each([false, true])(
    "ignores native truncated=%s and read revision when metrics certify exact rows",
    async (truncated) => {
      const { native, backend } = await fixture();
      try {
        const token = await capture(backend);
        const read = buffer("recent", "red\n\nview A\nview B\n");
        read.read.truncated = truncated;
        read.read.revision = 999;
        native.intercept = (method) => (method === "pane.read" ? Promise.resolve(read) : undefined);
        expect(await backend.getHistoryPage!("t1", request(token))).toMatchObject({
          status: "page",
          from: 8,
          to: 10,
          oldestAvailable: 7,
        });
      } finally {
        await backend.close();
      }
    },
  );

  it("returns a partial native-window page and refuses deeper acquisition, bounded by 1000/200", async () => {
    const { native, backend } = await fixture();
    try {
      native.info.pane.scroll.max_offset_from_bottom = 3000;
      native.recent = Array.from({ length: 3002 }, (_, i) => `r${i}`);
      const token = await capture(backend);
      native.calls = [];
      const partial = await backend.getHistoryPage!(
        "t1",
        request(token, { reported: 4000, before: 3050, count: 200 }),
      );
      expect(partial).toMatchObject({
        status: "page",
        from: 3002,
        to: 3050,
        oldestAvailable: 1000,
      });
      if (partial.status === "page") {
        expect(partial.lines).toHaveLength(48);
        expect(partial.lines[0]).toEqual({ r: [{ t: "r2002" }] });
        expect(partial.lines[47]).toEqual({ r: [{ t: "r2049" }] });
      }
      expect(native.calls.find((c) => c.method === "pane.read")?.params.lines).toBe(1000);
      native.calls = [];
      expect(
        await backend.getHistoryPage!(
          "t1",
          request(token, { reported: 4000, before: 3002, count: 200 }),
        ),
      ).toEqual({ status: "unavailable", reason: "fetch-window" });
      expect(native.calls.map((c) => c.method)).toEqual(["pane.get"]);
      const full = await backend.getHistoryPage!(
        "t1",
        request(token, { reported: 4000, before: 4000, count: 200 }),
      );
      expect(full.status).toBe("page");
      if (full.status === "page") expect(full.lines).toHaveLength(200);
      expect(
        native.calls
          .filter((c) => c.method === "pane.read")
          .every((c) => Number(c.params.lines) <= 1000),
      ).toBe(true);
    } finally {
      await backend.close();
    }
  });

  it.each([
    "tall",
    "wide",
    "scrolled",
    "local-scroll",
    "viewport",
    "missing-facts",
    "rejected-facts",
  ])("omits capture for %s while preserving a usable legacy screen", async (flaw) => {
    const { native, backend } = await fixture();
    try {
      if (flaw === "tall") native.visible.read.text = "one\ntwo\nthree\n";
      if (flaw === "wide") native.visible.read.text = "123456789\nsecond\n";
      if (flaw === "scrolled") native.info.pane.scroll.offset_from_bottom = 1;
      if (flaw === "local-scroll")
        native.event("pane.scroll_changed", {
          pane_id: "p1",
          scroll: { offset_from_bottom: 1, max_offset_from_bottom: 3, viewport_rows: 2 },
        });
      if (flaw === "viewport") native.info.pane.scroll.viewport_rows = 3;
      if (flaw === "missing-facts")
        native.intercept = (method) =>
          method === "pane.get" ? Promise.resolve({ type: "pane_info" }) : undefined;
      if (flaw === "rejected-facts")
        native.intercept = (method) =>
          method === "pane.get" ? Promise.reject(new Error("synthetic")) : undefined;
      const screen = await backend.getScreen("t1", { history: true });
      expect(screen.historyCapture).toBeUndefined();
      expect(screen).toMatchObject({ rows: 2, cols: 8 });
      expect(screen.lines).toHaveLength(2);
    } finally {
      await backend.close();
    }
  });

  for (const before of [10, 7, 6]) {
    for (const cancelled of [false, true]) {
      it.each(["initial", "final"])(
        `cursor ${before}, cancelled=${cancelled}: checks caller ownership after %s facts helper returns`,
        async (stage) => {
          const { native, backend } = await fixture();
          try {
            const token = await capture(backend);
            const target = backend as unknown as { historyFacts(epoch: unknown): Promise<unknown> };
            const original = target.historyFacts.bind(backend);
            let gets = 0;
            const abort = new AbortController();
            const spy = vi.spyOn(target, "historyFacts").mockImplementation(async (epoch) => {
              const result = await original(epoch);
              if (++gets === (stage === "initial" ? 1 : 2))
                queueMicrotask(() => {
                  native.event("pane.scroll_changed", { pane_id: "p1" });
                  if (cancelled) abort.abort();
                });
              return result;
            });
            native.calls = [];
            expect(
              await backend.getHistoryPage!("t1", request(token, { before, signal: abort.signal })),
            ).toEqual({ status: cancelled ? "cancelled" : "reset" });
            expect(native.calls.map((c) => c.method)).toEqual(
              stage === "initial"
                ? ["pane.get"]
                : before === 10
                  ? ["pane.get", "pane.read", "pane.get"]
                  : ["pane.get", "pane.get"],
            );
            spy.mockRestore();
            await revokedWithoutQuery(native, backend, token);
          } finally {
            await backend.close();
          }
        },
      );
    }
  }

  for (const gap of ["initial", "visible", "final"] as const) {
    it.each(["revision", "scroll", "stream", "replacement"])(
      `capture ${gap} gap: %s omits evidence and stops extra acquisition`,
      async (change) => {
        const { native, backend } = await fixture();
        try {
          const pending = deferred<unknown>();
          let gets = 0;
          let hit = false;
          native.intercept = (method, params) => {
            if (method === "pane.get") gets++;
            if (
              (gap === "initial" && method === "pane.get" && gets === 1) ||
              (gap === "visible" && method === "pane.read" && params.source === "visible") ||
              (gap === "final" && method === "pane.get" && gets === 2)
            ) {
              hit = true;
              return pending.promise;
            }
          };
          const screen = backend.getScreen("t1", { history: true });
          await waitFor(() => hit);
          if (change === "revision")
            native.event("pane_updated", { pane: { ...paneInfo(), revision: 6 } });
          if (change === "scroll") native.event("pane.scroll_changed", { pane_id: "p1" });
          if (change === "stream") native.handlers!.onEnd("eof");
          if (change === "replacement") {
            await backend.close();
            await backend.connect();
          }
          native.intercept = undefined;
          const count = native.calls.length;
          pending.resolve(gap === "visible" ? native.visible : facts());
          expect((await screen).historyCapture).toBeUndefined();
          // A normal visible read still completes when the optional initial facts lost ownership.
          expect(native.calls.slice(count).map((c) => c.method)).toEqual(
            gap === "initial" ? ["pane.read"] : [],
          );
        } finally {
          await backend.close();
        }
      },
    );
  }

  it("a stale facts contradiction cannot revoke replacement capture ownership", async () => {
    const { native, backend } = await fixture();
    try {
      const old = await capture(backend);
      const pending = deferred<unknown>();
      let hit = false;
      native.intercept = (method) => {
        if (method === "pane.get") {
          hit = true;
          return pending.promise;
        }
      };
      const page = backend.getHistoryPage!("t1", request(old));
      await waitFor(() => hit);
      await backend.close();
      await backend.connect();
      native.intercept = undefined;
      const fresh = await capture(backend);
      const stale = facts();
      stale.pane.revision = 99;
      pending.resolve(stale);
      expect(await page).toEqual({ status: "reset" });
      await revokedWithoutQuery(native, backend, old);
      expect(await backend.getHistoryPage!("t1", request(fresh))).toMatchObject({
        status: "page",
        from: 8,
      });
    } finally {
      await backend.close();
    }
  });

  it.each(["resolved", "rejected"])(
    "a %s superseded bootstrap cannot replay buffered events into replacement panes",
    async (outcome) => {
      const native = new SyntheticHerdr();
      const backend = new HerdrBackend({ client: native, log, syncDebounceMs: 0 });
      const pending = deferred<unknown>();
      let snapshots = 0;
      native.intercept = (method) => {
        if (method === "session.snapshot" && ++snapshots === 2) return pending.promise;
      };
      try {
        const bootstrap = backend.connect();
        await waitFor(() => snapshots === 2);
        native.event("pane_updated", {
          pane: { ...paneInfo(), revision: 99, agent_status: "working" },
        });
        await backend.close();
        native.intercept = undefined;
        await backend.connect();
        const fresh = await capture(backend);
        const events: string[] = [];
        backend.on((event) => events.push(event.type));
        native.calls = [];
        if (outcome === "resolved") pending.resolve(native.snapshot);
        else pending.reject(new Error("synthetic superseded bootstrap failure"));
        await bootstrap;
        expect(events).toEqual([]);
        expect(native.calls).toEqual([]);
        expect(await backend.listSessions()).toMatchObject([{ id: "t1", state: "finished" }]);
        expect(await backend.getHistoryPage("t1", request(fresh))).toMatchObject({
          status: "page",
          from: 8,
          to: 10,
          oldestAvailable: 7,
        });
      } finally {
        await backend.close();
      }
    },
  );

  it.each(["resolved", "rejected"])(
    "a %s stale snapshot cannot overwrite or revoke a replacement stream's capture",
    async (outcome) => {
      const { native, backend } = await fixture();
      try {
        const sync = deferred<void>();
        const target = backend as unknown as { runSync(): Promise<void> };
        const original = target.runSync.bind(backend);
        const spy = vi.spyOn(target, "runSync").mockImplementation(async () => {
          try {
            await original();
          } finally {
            sync.resolve();
          }
        });
        const old = await capture(backend);
        const pending = deferred<unknown>();
        let hit = false;
        native.intercept = (method) => {
          if (method === "session.snapshot") {
            hit = true;
            return pending.promise;
          }
        };
        native.event("pane_agent_status_changed", { pane_id: "p1" });
        await waitFor(() => hit);
        await backend.close();
        native.intercept = undefined;
        await backend.connect();
        const fresh = await capture(backend);
        const stale = structuredClone(native.snapshot);
        stale.snapshot.panes[0]!.revision = 99;
        if (outcome === "resolved") pending.resolve(stale);
        else pending.reject(new Error("synthetic stale snapshot failure"));
        await sync.promise;
        spy.mockRestore();
        await revokedWithoutQuery(native, backend, old);
        expect(await backend.getHistoryPage!("t1", request(fresh))).toMatchObject({
          status: "page",
          from: 8,
        });
      } finally {
        await backend.close();
      }
    },
  );

  it("a contradictory delayed same-stream snapshot conservatively revokes a newer capture", async () => {
    const { native, backend } = await fixture();
    try {
      const pending = deferred<unknown>();
      native.intercept = (method) => (method === "session.snapshot" ? pending.promise : undefined);
      const refresh = (
        backend as unknown as { refreshSnapshot(): Promise<void> }
      ).refreshSnapshot();
      native.info.pane.scroll.max_offset_from_bottom = 4;
      native.event("pane.scroll_changed", { pane_id: "p1", scroll: native.info.pane.scroll });
      const newer = await capture(backend);
      pending.resolve(native.snapshot);
      await refresh;
      native.intercept = undefined;
      native.calls = [];
      // Keep the newer capture's valid H=4 native facts; only local reconciliation revoked it.
      const result = await backend.getHistoryPage!("t1", request(newer));
      expect(native.calls).toEqual([]);
      expect(result).toEqual({ status: "reset" });
    } finally {
      await backend.close();
    }
  });

  it.each(["geometry", "identity", "removal"] as const)(
    "snapshot %s change revokes restored ownership",
    async (change) => {
      const { native, backend } = await fixture();
      try {
        const token = await capture(backend);
        if (change === "geometry") native.snapshot.snapshot.layouts[0]!.panes[0]!.rect.width = 9;
        if (change === "identity") native.snapshot.snapshot.panes[0]!.pane_id = "p2";
        if (change === "removal") native.snapshot.snapshot.panes = [];
        native.calls = [];
        native.event("pane_agent_status_changed", { pane_id: "p1" });
        await waitForAsync(async () => {
          const sessions = await backend.listSessions();
          return change === "removal"
            ? sessions.length === 0
            : change === "geometry"
              ? sessions[0]?.cols === 9
              : native.calls.filter((c) => c.method === "session.snapshot").length >= 2;
        });
        native.snapshot.snapshot.panes = [paneInfo()];
        native.snapshot.snapshot.layouts[0]!.panes[0]!.rect.width = 8;
        if (change === "geometry") native.event("pane_agent_status_changed", { pane_id: "p1" });
        else native.event("pane_created", { pane_id: "p1" });
        await waitForAsync(async () => (await backend.listSessions())[0]?.cols === 8);
        await revokedWithoutQuery(native, backend, token);
      } finally {
        await backend.close();
      }
    },
  );

  for (const before of [6, 7]) {
    it.each(["abort", "scroll", "replacement"])(
      `boundary cursor ${before}: final gap %s cannot publish end/truncated`,
      async (change) => {
        const { native, backend } = await fixture();
        try {
          const token = await capture(backend);
          const pending = deferred<unknown>();
          let gets = 0;
          native.intercept = (method) =>
            method === "pane.get" && ++gets === 2 ? pending.promise : undefined;
          const abort = new AbortController();
          const result = backend.getHistoryPage!(
            "t1",
            request(token, { before, signal: abort.signal }),
          );
          await waitFor(() => gets === 2);
          if (change === "abort") abort.abort();
          if (change === "scroll") native.event("pane.scroll_changed", { pane_id: "p1" });
          if (change === "replacement") {
            await backend.close();
            await backend.connect();
          }
          pending.resolve(facts());
          expect(await result).toEqual({ status: change === "abort" ? "cancelled" : "reset" });
          if (change !== "abort") await revokedWithoutQuery(native, backend, token);
        } finally {
          await backend.close();
        }
      },
    );
  }
});
