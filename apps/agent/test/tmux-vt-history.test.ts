import { describe, expect, it } from "vitest";
import type { TmuxControl } from "../src/backends/tmux/control.js";
import { TmuxVtHistory } from "../src/backends/tmux/vt-history.js";
import type { HistoryReadRequest } from "../src/backends/types.js";

const facts = (change: Partial<Record<number, string>> = {}) =>
  ["0", "1", "10", "20", "2", "100", "0"].map((v, i) => change[i] ?? v).join("\t");

function fixture() {
  let rows = ["older6", "older7"];
  let display = facts();
  let settle: (() => void) | undefined;
  let hold = false;
  const calls: string[][] = [];
  const control = {
    alive: true,
    async checkpoint(commands: string[]) {
      calls.push(commands);
      if (hold)
        await new Promise<void>((resolve) => {
          settle = resolve;
        });
      return {
        sentSeq: 1,
        outputSeq: 1,
        replies: commands.length === 2 ? [[display], [display]] : [[display], rows, [display]],
      };
    },
  };
  const history = new TmuxVtHistory(control as unknown as TmuxControl, "%1");
  const capture = () =>
    history.capture(
      [[], [], [], [], [], [facts()], ["new8", "new9"]],
      { cols: 20, rows: 2 },
      2,
      1,
      "replay",
      history.revision,
    );
  history.enable();
  const anchor = capture()!;
  const controller = new AbortController();
  const request: HistoryReadRequest = {
    capture: anchor.capture,
    reported: 10,
    before: 8,
    count: 2,
    signal: controller.signal,
  };
  return {
    control,
    history,
    anchor,
    capture,
    request,
    controller,
    calls,
    rows(value: string[]) {
      rows = value;
    },
    facts(value: string) {
      display = value;
    },
    hold() {
      hold = true;
    },
    settle() {
      hold = false;
      settle!();
    },
  };
}

describe("raw tmux history capture", () => {
  it("binds physical seed rows and older pages to the same native capture", async () => {
    const f = fixture();
    expect(f.anchor).toMatchObject({
      from: 8,
      to: 10,
      lines: [{ r: [{ t: "new8" }] }, { r: [{ t: "new9" }] }],
    });
    expect(await f.history.read(f.request)).toEqual({
      status: "page",
      from: 6,
      to: 8,
      oldestAvailable: 0,
      lines: [{ r: [{ t: "older6" }] }, { r: [{ t: "older7" }] }],
    });
    expect(f.calls[0]![1]).toBe("capture-pane -p -e -N -S -4 -E -3 -t %1");
  });

  it("does no extra capture unless enabled", () => {
    const f = fixture();
    const reader = new TmuxVtHistory(f.control as unknown as TmuxControl, "%1");
    expect(reader.commands(2)).toEqual([]);
    reader.enable();
    expect(reader.commands(2)).toHaveLength(2);
  });

  it("rejects copied and foreign tokens and a different reported origin", async () => {
    const f = fixture();
    for (const capture of [{ ...f.anchor.capture }, fixture().anchor.capture])
      expect(await f.history.read({ ...f.request, capture })).toMatchObject({
        status: "unavailable",
        reason: "unanchored",
      });
    expect(await f.history.read({ ...f.request, reported: 11 })).toMatchObject({
      status: "unavailable",
      reason: "unanchored",
    });
    expect(f.calls).toHaveLength(0);
  });

  for (const change of [
    { 0: "1" },
    { 1: "0" },
    { 2: "11" },
    { 3: "21" },
    { 4: "3" },
    { 5: "10" },
    { 6: "1" },
  ])
    it(`retires a native capture when facts change: ${JSON.stringify(change)}`, async () => {
      const f = fixture();
      f.facts(facts(change));
      expect(await f.history.read(f.request)).toEqual({ status: "reset" });
      expect(await f.history.read(f.request)).toMatchObject({ status: "unavailable" });
    });

  for (const event of ["output", "layout", "close"] as const)
    it(`cannot deliver a page after ${event} during a native read`, async () => {
      const f = fixture();
      f.hold();
      const result = f.history.read(f.request);
      if (event === "output") f.history.output(2);
      else if (event === "layout") f.history.invalidate();
      else f.history.close();
      f.settle();
      expect(await result).toEqual({ status: "reset" });
    });

  it("keeps the command admission through cancelled work, including a new seed", async () => {
    const f = fixture();
    f.hold();
    const result = f.history.read(f.request);
    f.controller.abort();
    const next = f.capture()!;
    const request = { ...f.request, capture: next.capture, signal: new AbortController().signal };
    expect(await f.history.read(request)).toEqual({ status: "unavailable", reason: "busy" });
    f.settle();
    expect(await result).toEqual({ status: "cancelled" });
    expect(await f.history.read(request)).toMatchObject({ status: "page" });
  });

  it("checks native facts even at the oldest boundary", async () => {
    const f = fixture();
    expect(await f.history.read({ ...f.request, before: 0 })).toEqual({
      status: "boundary",
      reason: "end",
      oldestAvailable: 0,
    });
    f.facts(facts({ 2: "0" }));
    expect(await f.history.read({ ...f.request, before: 0 })).toEqual({ status: "reset" });
  });

  it("does not infer rows when capture is short or contains ambiguous tabs", async () => {
    const f = fixture();
    f.rows(["short"]);
    expect(await f.history.read(f.request)).toMatchObject({
      status: "unavailable",
      reason: "unanchored",
    });
    f.rows(["a\tb", "row"]);
    expect(await f.history.read(f.request)).toMatchObject({
      status: "unavailable",
      reason: "unanchored",
    });
  });

  it("mints no seed proof after output beyond the checkpoint or a layout race", () => {
    const f = fixture();
    const replies = [[], [], [], [], [], [facts()], ["new8", "new9"]];
    const revision = f.history.revision;
    f.history.invalidate();
    expect(f.history.capture(replies, { cols: 20, rows: 2 }, 2, 1, "", revision)).toBeUndefined();
    f.history.output(2);
    expect(f.capture()).toBeUndefined();
    // Output on or before the checkpoint is included in the capture.
    expect(
      f.history.capture(replies, { cols: 20, rows: 2 }, 2, 2, "", f.history.revision),
    ).toBeDefined();
  });
});
