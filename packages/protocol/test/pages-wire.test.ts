import { describe, expect, it } from "vitest";
import {
  encodeCbor,
  MAX_TERMINAL_MESSAGE_BYTES,
  WEB_LIMITS,
  type WebMessage,
  WebMessageSchema,
  WebPagesSchema,
  WebSender,
  webCharge,
} from "../src/index.js";

describe("registered Pages metadata", () => {
  it("bounds printable names, catalog size and icon chunks within the existing route budget", () => {
    const page = { id: "board", name: "Board", icon: "a".repeat(64) };
    expect(
      WebPagesSchema.safeParse(Array.from({ length: 16 }, (_, n) => ({ ...page, id: `page-${n}` })))
        .success,
    ).toBe(true);
    expect(WebPagesSchema.safeParse(Array(17).fill(page)).success).toBe(false);
    expect(WebPagesSchema.safeParse([{ ...page, name: "x\ncommand" }]).success).toBe(false);
    const frame = {
      type: "web.icon.data",
      page: "board",
      hash: page.icon,
      total: WEB_LIMITS.iconBytes,
      offset: 0,
      bytes: new Uint8Array(WEB_LIMITS.iconChunkBytes),
    };
    expect(WebMessageSchema.safeParse(frame).success).toBe(true);
    expect(encodeCbor(frame).byteLength).toBeLessThan(MAX_TERMINAL_MESSAGE_BYTES);
    expect(WebMessageSchema.safeParse({ ...frame, offset: WEB_LIMITS.iconBytes }).success).toBe(
      false,
    );
    expect(
      WebMessageSchema.safeParse({ ...frame, bytes: new Uint8Array(WEB_LIMITS.iconChunkBytes + 1) })
        .success,
    ).toBe(false);
    expect(
      WebMessageSchema.safeParse({
        ...frame,
        bytes: undefined,
        offset: undefined,
        total: undefined,
      }).success,
    ).toBe(true);
  });
  it("charges metadata to the same connection window and preserves credit while replacing stale images", () => {
    const sent: WebMessage[] = [];
    const sender = new WebSender({
      send: (m) => {
        sent.push(m);
        return true;
      },
    });
    for (let n = 0; n < 16; n++)
      for (let offset = 0; offset < WEB_LIMITS.iconBytes; offset += WEB_LIMITS.iconChunkBytes)
        sender.frame({
          type: "web.icon.data",
          page: `page-${n}`,
          hash: "a".repeat(64),
          offset,
          total: WEB_LIMITS.iconBytes,
          bytes: new Uint8Array(WEB_LIMITS.iconChunkBytes),
        });
    expect(sent.reduce((n, m) => n + webCharge(m), 0)).toBeLessThanOrEqual(
      WEB_LIMITS.connectionWindow,
    );
    const before = sent.length;
    sender.dropIcon("page-15");
    while (sender.outstanding) {
      const charge = sender.outstanding;
      expect(sender.receiveCredit({ type: "web.credit", stream: 0, bytes: charge })).toBe(true);
    }
    expect(sent.length).toBeGreaterThan(before);
    expect(sent.filter((m) => m.type === "web.icon.data" && m.page === "page-15")).toHaveLength(0);
    sender.close();
  });
});
