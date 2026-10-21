import type { Line } from "@shellbell/protocol";
import { describe, expect, it } from "vitest";
import { HerdrVtHistory } from "../src/backends/herdr/vt-history.js";
import type { HerdrVtPane } from "../src/backends/herdr/vt-source.js";
import type { AgentState, HistoryReadRequest } from "../src/backends/types.js";

const lines = (...rows: string[]): Line[] => rows.map((t) => ({ r: [{ t }] }));
function fixture() {
  let pane: HerdrVtPane | undefined = {
    paneId: "p1",
    terminalId: "t1",
    cols: 20,
    rows: 4,
    agent: false,
    agentStatus: "unknown",
  };
  const facts = {
    paneId: "p1",
    terminalId: "t1",
    revision: 7,
    history: 4,
    viewportRows: 4,
    offset: 0,
    source: {
      agent: null as string | null,
      displayAgent: null as string | null,
      status: "unknown" as AgentState,
    },
  };
  let recent = ["old0", "old1", "new2", "new3", "view0", "view1"];
  const calls: { method: string; params: Record<string, unknown> }[] = [];
  let hold = false;
  let release: (() => void) | undefined;
  const history = new HerdrVtHistory({
    pane: () => pane,
    request: async <T>(method: string, params: Record<string, unknown>): Promise<T> => {
      calls.push({ method, params });
      if (hold)
        await new Promise<void>((resolve) => {
          release = resolve;
        });
      if (method === "pane.get")
        return {
          type: "pane_info",
          pane: {
            pane_id: "p1",
            terminal_id: "t1",
            revision: facts.revision,
            agent: facts.source.agent,
            display_agent: facts.source.displayAgent,
            agent_status: facts.source.status,
            scroll: {
              offset_from_bottom: facts.offset,
              max_offset_from_bottom: facts.history,
              viewport_rows: facts.viewportRows,
            },
          },
        } as T;
      return {
        type: "pane_read",
        read: {
          pane_id: "p1",
          source: "recent",
          format: "ansi",
          truncated: false,
          text: recent.slice(-Number(params.lines)).join("\n"),
        },
      } as T;
    },
  });
  history.enable();
  const frame = () => ({
    facts: { ...facts },
    above: lines("new2", "new3"),
    visible: lines("view0", "view1"),
  });
  const capture = () => history.capture(pane!, frame(), "replay");
  const anchor = capture()!;
  const controller = new AbortController();
  const request: HistoryReadRequest = {
    capture: anchor.capture,
    reported: 4,
    before: 2,
    count: 2,
    signal: controller.signal,
  };
  return {
    history,
    facts,
    calls,
    anchor,
    frame,
    capture,
    request,
    controller,
    get pane() {
      return pane!;
    },
    replacePane(value: HerdrVtPane | undefined) {
      pane = value;
    },
    recent(value: string[]) {
      recent = value;
    },
    hold() {
      hold = true;
    },
    release() {
      hold = false;
      release!();
    },
  };
}

describe("raw Herdr history capture", () => {
  it("joins a seed and older native rows through the same physical visible suffix", async () => {
    const f = fixture();
    expect(f.anchor).toMatchObject({ from: 2, to: 4, lines: lines("new2", "new3") });
    expect(await f.history.read(f.request)).toEqual({
      status: "page",
      from: 0,
      to: 2,
      oldestAvailable: 0,
      lines: lines("old0", "old1"),
    });
    expect(f.calls.map((call) => call.method)).toEqual(["pane.get", "pane.read", "pane.get"]);
  });

  it("rejects copied capabilities and mismatched coordinates before reading", async () => {
    const f = fixture();
    expect(await f.history.read({ ...f.request, capture: { ...f.anchor.capture } })).toMatchObject({
      status: "unavailable",
    });
    expect(await f.history.read({ ...f.request, reported: 5 })).toMatchObject({
      status: "unavailable",
    });
    expect(f.calls).toHaveLength(0);
  });

  for (const key of ["revision", "history", "viewportRows", "offset"] as const)
    it(`rejects a changed ${key}`, async () => {
      const f = fixture();
      f.facts[key]++;
      expect(await f.history.read(f.request)).toEqual({ status: "reset" });
    });

  for (const change of [
    { cols: 21 },
    { rows: 5 },
    { terminalId: "t2" },
    { paneId: "p2" },
    { agent: true },
    { agentStatus: "idle" as const },
  ])
    it(`retires a capture when its pane changes: ${JSON.stringify(change)}`, async () => {
      const f = fixture();
      f.replacePane({ ...f.pane, ...change });
      expect(await f.history.read(f.request)).toEqual({ status: "reset" });
      expect(f.calls).toHaveLength(0);
    });

  it("rejects mismatched/short visible suffixes instead of guessing their alignment", async () => {
    const f = fixture();
    for (const recent of [
      ["old1", "new2", "new3", "changed", "view1"],
      ["view0", "view1"],
    ]) {
      f.recent(recent);
      expect(await f.history.read(f.request)).toMatchObject({
        status: "unavailable",
        reason: "changed",
      });
    }
  });

  it("reports the API fetch window without inventing an oldest boundary", async () => {
    const f = fixture();
    f.facts.history = 2000;
    const anchor = f.capture()!;
    expect(
      await f.history.read({ ...f.request, capture: anchor.capture, reported: 2000, before: 1 }),
    ).toEqual({ status: "unavailable", reason: "fetch-window" });
  });

  it("withholds proof for idle agent transcripts and unaligned empty viewports", () => {
    const f = fixture();
    f.replacePane({ ...f.pane, agent: true, agentStatus: "idle" });
    expect(f.capture()).toBeUndefined();
    f.replacePane({ ...f.pane, agent: false });
    expect(f.history.capture(f.pane, { ...f.frame(), visible: [] }, "")).toBeUndefined();
    expect(
      f.history.capture(f.pane, { ...f.frame(), above: lines(...Array(5).fill("row")) }, ""),
    ).toBeUndefined();
  });

  it("uses native agent status when the event cache still says working or has no agent", async () => {
    for (const cachedAgent of [true, false]) {
      const f = fixture();
      f.replacePane({ ...f.pane, agent: cachedAgent, agentStatus: "working" });
      f.facts.source.agent = "codex";
      f.facts.source.status = "working";
      const anchor = f.capture()!;
      expect(anchor).toBeDefined();
      f.facts.source.status = "idle";
      expect(await f.history.read({ ...f.request, capture: anchor.capture })).toEqual({
        status: "reset",
      });
      expect(f.capture()).toBeUndefined();
    }
  });

  it("does not call an API fetch-window limit the end of retained native history", async () => {
    const f = fixture();
    f.facts.history = 2000;
    f.recent([...Array.from({ length: 2000 }, (_, i) => `r${i}`), "view0", "view1"]);
    const anchor = f.capture()!;
    const request = {
      ...f.request,
      capture: anchor.capture,
      reported: 2000,
      before: 1010,
      count: 20,
    };
    const page = await f.history.read(request);
    expect(page).toMatchObject({ status: "page", from: 1002, to: 1010, oldestAvailable: 0 });
    expect(await f.history.read({ ...request, before: 1002 })).toEqual({
      status: "unavailable",
      reason: "fetch-window",
    });
  });

  for (const kind of ["cancel", "close", "observe"] as const)
    it(`fences a pending read on ${kind} and holds admission until settlement`, async () => {
      const f = fixture();
      f.hold();
      const result = f.history.read(f.request);
      if (kind === "cancel") f.controller.abort();
      else if (kind === "close") f.history.close();
      else f.history.observe(f.pane, { ...f.facts, revision: 8 });
      if (kind !== "close") {
        const next = f.capture()!;
        expect(
          await f.history.read({
            ...f.request,
            capture: next.capture,
            signal: new AbortController().signal,
          }),
        ).toMatchObject({ status: "unavailable", reason: "busy" });
      }
      f.release();
      expect(await result).toEqual({ status: kind === "cancel" ? "cancelled" : "reset" });
    });

  it("checks both sides of an empty oldest boundary", async () => {
    const f = fixture();
    expect(await f.history.read({ ...f.request, before: 0 })).toEqual({
      status: "boundary",
      reason: "end",
      oldestAvailable: 0,
    });
    expect(f.calls.map((call) => call.method)).toEqual(["pane.get", "pane.get"]);
  });
});
