import { describe, expect, it } from "vitest";
import {
  classifyWebLink,
  connectAddresses,
  decodeCbor,
  encodeCbor,
  parseInner,
  parseLocalOrigin,
  sameLocalPage,
  WEB_LIMITS,
  WebMessageSchema,
  webCharge,
} from "../src/index.js";
import { encodeV2Frame } from "../src/session-v2.js";
import { encodeV2RoutePayload } from "../src/session-v2-route-wire.js";

const bytes = (n: number) => new Uint8Array(n).fill(65);
const open = {
  type: "web.open",
  stream: 1,
  target: { origin: "http://localhost:5173" },
  method: "GET",
  path: "/",
  headers: [["accept", bytes(3)]],
  body: false,
  upgrade: false,
} as const;

describe("web wire", () => {
  it("round-trips every message through the inner schema", () => {
    const messages = [
      open,
      { type: "web.head", stream: 1, status: 200, headers: [], end: true },
      {
        type: "web.head",
        stream: 1,
        status: 101,
        headers: [],
        bytes: bytes(4),
        authority: { authority: "localhost:5173", family: 6 },
      },
      { type: "web.data", stream: 1, bytes: bytes(16_384) },
      { type: "web.end", stream: 1 },
      { type: "web.credit", stream: 0, bytes: 300 },
      { type: "web.reset", stream: 1, reason: "unreachable", detail: "Nothing is answering" },
      { type: "web.view", target: { page: "sous" }, open: true },
    ];
    for (const message of messages)
      expect(parseInner(decodeCbor(encodeCbor(message)))).toEqual(message);
  });

  it("enforces size and shape bounds", () => {
    const bad = [
      { ...open, stream: 0 },
      { ...open, path: "relative" },
      { ...open, path: `/${"a".repeat(WEB_LIMITS.pathBytes)}` },
      { ...open, method: "GET POST" },
      { ...open, headers: [["bad name", bytes(1)]] },
      { ...open, headers: [["x", bytes(WEB_LIMITS.openBytes)]] },
      { ...open, target: { page: "Sous" } },
      { ...open, target: { origin: "x".repeat(257) } },
      { ...open, extra: true },
      { type: "web.head", stream: 1, status: 102, headers: [] },
      { type: "web.head", stream: 1, status: 200, headers: [], bytes: bytes(4097) },
      { type: "web.head", stream: 1, status: 200, headers: [["x", bytes(16_384)]] },
      { type: "web.data", stream: 1, bytes: bytes(0) },
      { type: "web.data", stream: 1, bytes: bytes(16_385) },
      { type: "web.credit", stream: 0, bytes: 0 },
      { type: "web.reset", stream: 1, reason: "nope" },
      { type: "web.reset", stream: 1, reason: "closed", detail: "line\nbreak" },
    ];
    for (const message of bad) expect(WebMessageSchema.safeParse(message).success).toBe(false);
  });

  it("charges the encoded inner length plus the allowance, and only for charged types", () => {
    const data = { type: "web.data", stream: 7, bytes: bytes(1) } as const;
    expect(webCharge(data)).toBe(encodeCbor(data).byteLength + WEB_LIMITS.frameAllowance);
    expect(webCharge({ type: "web.end", stream: 7 })).toBe(0);
    expect(webCharge({ type: "web.credit", stream: 0, bytes: 1 })).toBe(0);
  });

  it("keeps the real channel overhead of a frame under the allowance", () => {
    for (const size of [1, 1000, 16_384]) {
      const message = { type: "web.data", stream: 0xffff_ffff, bytes: bytes(size) } as const;
      const inner = encodeCbor(message);
      const plaintext = encodeV2RoutePayload({ kind: "terminal", bytes: inner });
      const wire = encodeV2Frame({
        v: 2,
        type: "data",
        sessionId: bytes(16),
        generation: new Uint8Array([2, 0, 0, 0, 0, 0, 0, 0]),
        seq: bytes(8),
        ciphertext: new Uint8Array(plaintext.byteLength + 16),
      });
      expect(wire.byteLength - inner.byteLength).toBeLessThan(WEB_LIMITS.frameAllowance);
    }
  });
});

describe("web targets", () => {
  it("accepts only http on loopback names", () => {
    expect(parseLocalOrigin("http://localhost:5173")).toMatchObject({
      authority: "localhost:5173",
      port: 5173,
      host: { kind: "name", name: "localhost" },
    });
    expect(parseLocalOrigin("http://127.0.0.1")).toMatchObject({
      authority: "127.0.0.1",
      port: 80,
    });
    expect(parseLocalOrigin("http://[::1]:8888")?.host).toEqual({ kind: "ipv6" });
    expect(parseLocalOrigin("http://Alice.LOCALHOST:3000")?.authority).toBe("alice.localhost:3000");
    expect(parseLocalOrigin("http://0.0.0.0:3000")?.authority).toBe("localhost:3000");
    expect(parseLocalOrigin("http://[::]:3000")?.authority).toBe("localhost:3000");
    for (const origin of [
      "https://localhost:5173",
      "http://localhost:5173/",
      "http://example.com",
      "http://127.0.0.2",
      "http://user@localhost",
      "http://localhost:0",
      "http://localhost:65536",
      "http://bad_label.localhost",
      "http://localhost.:80",
    ])
      expect(parseLocalOrigin(origin), origin).toBeNull();
  });

  it("classifies links", () => {
    expect(classifyWebLink("http://localhost:5173/a?b#c")).toMatchObject({
      kind: "local",
      path: "/a?b",
    });
    expect(classifyWebLink("http://127.0.0.1:8888")).toMatchObject({ kind: "local", path: "/" });
    expect(classifyWebLink("https://localhost:5173").kind).toBe("secure-local");
    expect(classifyWebLink("https://example.com/x").kind).toBe("public");
    expect(classifyWebLink("http://localhost@example.com").kind).toBe("public");
    expect(classifyWebLink("http://example.com@localhost").kind).toBe("refused");
    expect(classifyWebLink("file:///etc/passwd").kind).toBe("refused");
    expect(classifyWebLink("javascript:alert(1)").kind).toBe("refused");
  });

  it("keeps address families and tries names on both", () => {
    const local = (origin: string) => {
      const parsed = parseLocalOrigin(origin);
      if (!parsed) throw new Error(origin);
      return parsed;
    };
    expect(connectAddresses(local("http://127.0.0.1").host)).toEqual([
      { address: "127.0.0.1", family: 4 },
    ]);
    expect(connectAddresses(local("http://[::1]").host)).toEqual([{ address: "::1", family: 6 }]);
    expect(connectAddresses(local("http://localhost").host).map((a) => a.family)).toEqual([4, 6]);
    const page = local("http://localhost:3000");
    expect(sameLocalPage(page, 4, local("http://127.0.0.1:3000"))).toBe(true);
    expect(sameLocalPage(page, 4, local("http://[::1]:3000"))).toBe(false);
    expect(sameLocalPage(page, 6, local("http://[::1]:3000"))).toBe(true);
    expect(sameLocalPage(page, 4, local("http://127.0.0.1:3001"))).toBe(false);
    expect(sameLocalPage(page, 4, local("http://alice.localhost:3000"))).toBe(false);
    const alice = local("http://alice.localhost:3000");
    expect(sameLocalPage(alice, 4, local("http://alice.localhost:3000"))).toBe(true);
    expect(sameLocalPage(alice, 4, local("http://bob.localhost:3000"))).toBe(false);
    expect(sameLocalPage(alice, 4, local("http://localhost:3000"))).toBe(false);
  });
});
