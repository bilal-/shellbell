import { describe, expect, it } from "vitest";
import { exactPhysicalRows, parseHistoryFacts } from "../src/backends/herdr/history.js";

const paneInfo = (overrides: Record<string, unknown> = {}) => ({
  type: "pane_info",
  pane: {
    pane_id: "pane-1",
    terminal_id: "terminal-1",
    revision: 7,
    scroll: {
      offset_from_bottom: 0,
      max_offset_from_bottom: 3,
      viewport_rows: 2,
    },
  },
  ...overrides,
});

const paneRead = (overrides: Record<string, unknown> = {}) => ({
  type: "pane_read",
  read: {
    pane_id: "pane-1",
    source: "visible",
    format: "ansi",
    text: "first\n\n\u001B[31mstyled\u001B[0m\n",
    truncated: false,
  },
  ...overrides,
});

describe("parseHistoryFacts", () => {
  it("accepts the exact pane facts while allowing unrelated fields", () => {
    expect(
      parseHistoryFacts(paneInfo({ ignored: { future: true } }), "pane-1", "terminal-1"),
    ).toEqual({
      paneId: "pane-1",
      terminalId: "terminal-1",
      revision: 7,
      history: 3,
      viewportRows: 2,
      offset: 0,
    });
  });

  it("rejects malformed facts and impossible scroll arithmetic", () => {
    const cases: unknown[] = [
      null,
      [],
      { type: "pane_info" },
      { type: "pane_info", pane: [] },
      paneInfo({ type: "pane_updated" }),
      paneInfo({ pane: { pane_id: "", terminal_id: "terminal-1", revision: 7, scroll: {} } }),
      paneInfo({ pane: { pane_id: "pane-1", terminal_id: "", revision: 7, scroll: {} } }),
      paneInfo({
        pane: { pane_id: "pane-1", terminal_id: "terminal-1", revision: "7", scroll: [] },
      }),
      paneInfo({ pane: { pane_id: "other", terminal_id: "terminal-1", revision: 7, scroll: {} } }),
      paneInfo({ pane: { pane_id: "pane-1", terminal_id: "other", revision: 7, scroll: {} } }),
      ...[-1, 1.5, Number.MAX_SAFE_INTEGER + 1].map((revision) =>
        paneInfo({
          pane: {
            pane_id: "pane-1",
            terminal_id: "terminal-1",
            revision,
            scroll: { offset_from_bottom: 0, max_offset_from_bottom: 3, viewport_rows: 2 },
          },
        }),
      ),
      ...[-1, 1.5, Number.MAX_SAFE_INTEGER + 1].map((history) =>
        paneInfo({
          pane: {
            pane_id: "pane-1",
            terminal_id: "terminal-1",
            revision: 7,
            scroll: { offset_from_bottom: 0, max_offset_from_bottom: history, viewport_rows: 2 },
          },
        }),
      ),
      ...[0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1].map((viewport_rows) =>
        paneInfo({
          pane: {
            pane_id: "pane-1",
            terminal_id: "terminal-1",
            revision: 7,
            scroll: { offset_from_bottom: 0, max_offset_from_bottom: 3, viewport_rows },
          },
        }),
      ),
      ...[-1, 1.5, Number.MAX_SAFE_INTEGER + 1, 4].map((offset_from_bottom) =>
        paneInfo({
          pane: {
            pane_id: "pane-1",
            terminal_id: "terminal-1",
            revision: 7,
            scroll: { offset_from_bottom, max_offset_from_bottom: 3, viewport_rows: 2 },
          },
        }),
      ),
      paneInfo({
        pane: {
          pane_id: "pane-1",
          terminal_id: "terminal-1",
          revision: 7,
          scroll: {
            offset_from_bottom: Number.MAX_SAFE_INTEGER,
            max_offset_from_bottom: Number.MAX_SAFE_INTEGER,
            viewport_rows: 1,
          },
        },
      }),
    ];

    for (const value of cases) {
      expect(parseHistoryFacts(value, "pane-1", "terminal-1")).toBeNull();
    }
  });
});

describe("exactPhysicalRows", () => {
  const visible = { paneId: "pane-1", source: "visible" as const, rows: 3, cols: 20 };

  it("preserves exact visible physical rows, interior blank rows, and styles", () => {
    const value = paneRead();
    const rows = exactPhysicalRows(value, visible);

    expect(rows?.map((line) => line.r.map((run) => run.t).join(""))).toEqual([
      "first",
      "",
      "styled",
    ]);
    expect(rows?.[1]).toEqual({ r: [] });
    expect(rows?.[2]?.r[0]).toMatchObject({ t: "styled", fg: 1 });
  });

  it("accepts recent and either truncated value only when exact", () => {
    const expected = { paneId: "pane-1", source: "recent" as const, rows: 1, cols: 20 };

    for (const truncated of [false, true]) {
      expect(
        exactPhysicalRows(
          paneRead({
            read: {
              pane_id: "pane-1",
              source: "recent",
              format: "ansi",
              text: "recent\n",
              truncated,
              revision: "not an epoch",
            },
          }),
          expected,
        ),
      ).toEqual([{ r: [{ t: "recent" }] }]);
    }
  });

  it("does not fit, trim, filter, or pad inexact output", () => {
    for (const text of ["", "only", "one\ntwo\nthree\nfour", "a\nb\nc\n"]) {
      const expected = text === "a\nb\nc\n" ? { ...visible, rows: 2 } : visible;
      expect(
        exactPhysicalRows(
          paneRead({
            read: { pane_id: "pane-1", source: "visible", format: "ansi", text, truncated: false },
          }),
          expected,
        ),
      ).toBeNull();
    }
  });

  it("treats a single trailing newline as a delimiter, not an extra row", () => {
    expect(
      exactPhysicalRows(
        paneRead({
          read: {
            pane_id: "pane-1",
            source: "visible",
            format: "ansi",
            text: "only\n",
            truncated: false,
          },
        }),
        { ...visible, rows: 1 },
      ),
    ).toEqual([{ r: [{ t: "only" }] }]);
  });

  it("rejects invalid wrappers, read fields, dimensions, and oversized rows without mutation", () => {
    const original = paneRead();
    const before = structuredClone(original);
    const invalidValues: unknown[] = [
      null,
      [],
      { type: "pane_read" },
      { type: "pane_read", read: [] },
      paneRead({ type: "other" }),
      paneRead({
        read: { pane_id: "", source: "visible", format: "ansi", text: "a", truncated: false },
      }),
      paneRead({
        read: { pane_id: "other", source: "visible", format: "ansi", text: "a", truncated: false },
      }),
      paneRead({
        read: { pane_id: "pane-1", source: "other", format: "ansi", text: "a", truncated: false },
      }),
      paneRead({
        read: {
          pane_id: "pane-1",
          source: "visible",
          format: "plain",
          text: "a",
          truncated: false,
        },
      }),
      paneRead({
        read: { pane_id: "pane-1", source: "visible", format: "ansi", text: 1, truncated: false },
      }),
      paneRead({
        read: {
          pane_id: "pane-1",
          source: "visible",
          format: "ansi",
          text: "a",
          truncated: "false",
        },
      }),
      paneRead({
        read: {
          pane_id: "pane-1",
          source: "visible",
          format: "ansi",
          text: "123",
          truncated: false,
        },
      }),
    ];

    for (const value of invalidValues) {
      expect(exactPhysicalRows(value, { ...visible, rows: 1, cols: 2 })).toBeNull();
    }
    for (const rows of [0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
      expect(exactPhysicalRows(original, { ...visible, rows, cols: 20 })).toBeNull();
    }
    for (const cols of [0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
      expect(exactPhysicalRows(original, { ...visible, rows: 3, cols })).toBeNull();
    }
    for (const expected of [
      { ...visible, rows: undefined },
      { ...visible, cols: undefined },
    ]) {
      expect(exactPhysicalRows(original, expected as unknown as typeof visible)).toBeNull();
    }
    expect(original).toEqual(before);

    const expected = { ...visible };
    const expectedBefore = structuredClone(expected);
    expect(exactPhysicalRows(original, expected)).toBeTruthy();
    expect(expected).toEqual(expectedBefore);
  });
});
