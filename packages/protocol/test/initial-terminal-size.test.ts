import { describe, expect, it } from "vitest";
import { CreateWhereSchema, InitialTerminalSizeSchema, parseInner } from "../src/index.js";
import { parseInner as legacyParseInner } from "./fixtures/legacy-protocol-20260921/inner.js";

describe("initial window size contract", () => {
  it("keeps creation compatible in both directions with a pre-hint peer", () => {
    const oldRequest = {
      type: "session.create",
      reqId: "new-session",
      in: { kind: "tab", backend: "tmux" },
    };
    const request = {
      ...oldRequest,
      in: { ...oldRequest.in, initialSize: { cols: 54, rows: 40 } },
    };
    expect(parseInner(oldRequest)).toEqual(legacyParseInner(oldRequest));
    expect(legacyParseInner(request)).toEqual(oldRequest);
    expect(parseInner(request)).toEqual(request);
  });

  it("accepts a bounded preference only on a new independent window request", () => {
    const initialSize = { cols: 54, rows: 38 };
    expect(
      CreateWhereSchema.parse({ kind: "tab", backend: "herdr", host: "ghostty", initialSize }),
    ).toMatchObject({ initialSize });
    expect(CreateWhereSchema.parse({ kind: "tab", backend: "iterm2", initialSize })).toMatchObject({
      initialSize,
    });
    expect(
      CreateWhereSchema.safeParse({
        kind: "tab",
        backend: "iterm2",
        windowId: "iterm2:one",
        initialSize,
      }).success,
    ).toBe(false);
    expect(
      CreateWhereSchema.parse({
        kind: "split",
        sessionId: "tmux:one",
        direction: "vertical",
        initialSize,
      }),
    ).not.toHaveProperty("initialSize");
    expect(
      CreateWhereSchema.parse({ kind: "tab", backend: "herdr", host: "ghostty" }),
    ).not.toHaveProperty("initialSize");
  });
  it.each([
    { cols: 39, rows: 24 },
    { cols: 80, rows: 23 },
    { cols: 241, rows: 40 },
    { cols: 80, rows: 101 },
    { cols: 80.5, rows: 24 },
    { cols: Infinity, rows: 24 },
  ])("rejects invalid grid %j", (size) => {
    expect(InitialTerminalSizeSchema.safeParse(size).success).toBe(false);
  });
});
