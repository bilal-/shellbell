import type { Line } from "@shellbell/protocol";
import { describe, expect, it } from "vitest";
import type { MobileStreamSnapshot } from "../src/net/mobile-screen-stream";
import { projectReadingRows } from "../src/screen/reading-presentation";
import { OlderLoadIntent, projectStreamRows } from "../src/screen/stream-presentation";

const line = (t: string): Line => ({ r: [{ t }] });

describe("bounded stream presentation", () => {
  it("supplies positions that let reading join proven history/live continuity", () => {
    const snapshot: MobileStreamSnapshot = {
      status: "live",
      historyStatus: "ready",
      screen: {
        cols: 10,
        rows: 1,
        cursor: { x: 0, y: 0 },
        lines: [line("world")],
        scrollbackTotal: 10,
        gen: 1,
      },
      history: {
        anchor: { subscriptionId: "s", generation: 1, before: 10 },
        nextBefore: 9,
        readOnly: false,
        rows: [{ key: "s:9", row: 9, line: { ...line("hello "), w: true } }],
        gaps: [],
        encodedBytes: 5,
      },
    };
    expect(projectReadingRows(projectStreamRows(snapshot), null)).toMatchObject([
      {
        key: "s:9",
        sourceKeys: ["s:9", "live:0"],
        historyKey: "s:9",
        runs: [{ t: "hello " }, { t: "world" }],
      },
    ]);
  });
  it("keeps viewport cursor positions independent of retained history and gaps", () => {
    const snapshot = {
      status: "live",
      historyStatus: "reset",
      screen: {
        cols: 40,
        rows: 2,
        cursor: { x: 0, y: 1 },
        lines: [line("live 0"), line("live 1")],
        scrollbackTotal: 20,
        gen: 9,
      },
      history: {
        anchor: { subscriptionId: "old", generation: 1, before: 10 },
        nextBefore: 3,
        readOnly: true,
        rows: [
          { key: "h:3", row: 3, line: line("old 3") },
          { key: "h:4", row: 4, line: line("old 4") },
        ],
        gaps: [{ from: 5, to: 10 }],
        encodedBytes: 20,
      },
    } as MobileStreamSnapshot;
    const rows = projectStreamRows(snapshot);
    expect(rows.filter((r) => r.kind === "gap")).toHaveLength(2);
    expect(rows.filter((r) => r.kind === "line").map((r) => r.liveRowIndex)).toEqual([
      null,
      null,
      0,
      1,
    ]);
    expect(rows.at(-1)).toMatchObject({ kind: "line", key: "live:1", liveRowIndex: 1 });
    expect(rows.filter((r) => r.kind === "line").map((r) => r.absoluteRow)).toEqual([3, 4, 20, 21]);
    expect(rows.filter((r) => r.kind === "gap").every((r) => !("line" in r))).toBe(true);
  });

  it("requires a fresh drag for each automatic top edge load", () => {
    const intent = new OlderLoadIntent();
    expect(intent.consume()).toBe(false);
    intent.beginDrag();
    expect(intent.consume()).toBe(true);
    expect(intent.consume()).toBe(false);
    intent.beginDrag();
    expect(intent.consume()).toBe(true);
  });

  it("shows omitted rows between a short cached page and the live viewport", () => {
    const snapshot = {
      status: "live",
      historyStatus: "ready",
      screen: {
        cols: 10,
        rows: 1,
        cursor: { x: 0, y: 0 },
        lines: [line("live")],
        scrollbackTotal: 10,
        gen: 1,
      },
      history: {
        anchor: { subscriptionId: "s", generation: 1, before: 10 },
        nextBefore: 8,
        readOnly: false,
        rows: [{ key: "s:8", row: 8, line: line("old") }],
        gaps: [{ from: 9, to: 10 }],
        encodedBytes: 5,
      },
    } as MobileStreamSnapshot;
    expect(projectStreamRows(snapshot).map((row) => row.kind)).toEqual(["line", "gap", "line"]);
  });

  it("distinguishes a live scrollback gap from detached read-only history", () => {
    const snapshot = {
      status: "live",
      historyStatus: "ready",
      screen: {
        cols: 10,
        rows: 1,
        cursor: { x: 0, y: 0 },
        lines: [line("live")],
        scrollbackTotal: 12,
        gen: 2,
      },
      history: {
        anchor: { subscriptionId: "s", generation: 1, before: 10 },
        nextBefore: 9,
        readOnly: false,
        rows: [{ key: "s:9", row: 9, line: line("old") }],
        gaps: [],
        encodedBytes: 5,
      },
    } as MobileStreamSnapshot;
    expect(projectStreamRows(snapshot).find((row) => row.kind === "gap")).toMatchObject({
      label: "Recent output omitted",
    });
  });
});
