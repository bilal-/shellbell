import { createHash } from "node:crypto";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { gunzipSync } from "node:zlib";
import { encodeCbor, type WebMessage, type WebMessageOf } from "@shellbell/protocol";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CookieJar, CookieJars } from "../src/web/cookie-jar.js";
import { WebHost } from "../src/web/web-host.js";
import { headerBytes, headerText, rewriteLocation } from "../src/web/web-rewrite.js";

const servers: http.Server[] = [];
const hosts: WebHost[] = [];
const sockets: import("node:stream").Duplex[] = [];
afterEach(async () => {
  for (const host of hosts.splice(0)) host.close();
  for (const socket of sockets.splice(0)) socket.destroy();
  for (const server of servers) server.closeAllConnections();
  await Promise.all(
    servers.splice(0).map((s) => new Promise((resolve) => s.close(() => resolve(null)))),
  );
});

async function serve(
  handler: http.RequestListener,
  host = "127.0.0.1",
  setup?: (server: http.Server) => void,
): Promise<number> {
  const server = http.createServer(handler);
  server.on("upgrade", (_req, socket) => sockets.push(socket));
  setup?.(server);
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, host, resolve));
  return (server.address() as AddressInfo).port;
}

function harness(
  jars = new CookieJars(),
  extra: Pick<ConstructorParameters<typeof WebHost>[0], "timer" | "timeouts"> = {},
) {
  const sent: WebMessage[] = [];
  const waiters: Array<() => void> = [];
  const host = new WebHost({
    ...extra,
    phoneFp: "phone",
    jars,
    send: (message) => {
      sent.push(message);
      for (const w of waiters.splice(0)) w();
      return true;
    },
    log: { info: () => {}, warn: () => {} },
  });
  hosts.push(host);
  const receive = (message: WebMessage) => host.receive(message, encodeCbor(message).byteLength);
  const until = async (done: () => boolean, ms = 3000) => {
    const deadline = Date.now() + ms;
    while (!done()) {
      if (Date.now() > deadline)
        throw new Error(`timed out; sent ${JSON.stringify(sent.map((m) => m.type))}`);
      await new Promise<void>((resolve) => {
        waiters.push(resolve);
        setTimeout(resolve, 20);
      });
    }
  };
  const of = (stream: number) => sent.filter((m) => "stream" in m && m.stream === stream);
  const headOf = (stream: number) =>
    of(stream).find((m): m is WebMessageOf<"web.head"> => m.type === "web.head");
  const bodyOf = (stream: number) =>
    Buffer.concat(
      of(stream)
        .filter((m): m is WebMessageOf<"web.data"> => m.type === "web.data")
        .map((m) => Buffer.from(m.bytes)),
    );
  const finished = (stream: number) =>
    of(stream).some(
      (m) =>
        m.type === "web.end" || m.type === "web.reset" || (m.type === "web.head" && m.end === true),
    );
  return { host, sent, receive, until, of, headOf, bodyOf, finished, jars };
}

const h = (name: string, value: string): [string, Uint8Array] => [name, headerBytes(value)];
const header = (head: WebMessageOf<"web.head"> | undefined, name: string) => {
  const found = head?.headers.find(([n]) => n.toLowerCase() === name);
  return found ? headerText(found[1]) : undefined;
};
const DOOR = "127.0.0.1:41000";
function open(
  stream: number,
  port: number,
  extra: Partial<WebMessageOf<"web.open">> = {},
  hostName = "127.0.0.1",
): WebMessageOf<"web.open"> {
  return {
    type: "web.open",
    stream,
    target: { origin: `http://${hostName}:${port}` },
    method: "GET",
    path: "/",
    headers: [h("Host", DOOR)],
    body: false,
    upgrade: false,
    ...extra,
  };
}

describe("WebHost requests", () => {
  it("rewrites Host, Origin and Referer from the door to the target, and leaves a foreign Origin", async () => {
    const seen: http.IncomingHttpHeaders[] = [];
    const port = await serve((req, res) => {
      seen.push(req.headers);
      res.end("ok");
    });
    const t = harness();
    t.receive(
      open(1, port, {
        headers: [
          h("Host", DOOR),
          h("Origin", `http://${DOOR}`),
          h("Referer", `http://${DOOR}/a?b`),
        ],
      }),
    );
    t.receive(open(3, port, { headers: [h("Host", DOOR), h("Origin", "http://evil.example")] }));
    await t.until(() => t.finished(1) && t.finished(3));
    expect(seen[0]).toMatchObject({
      host: `127.0.0.1:${port}`,
      origin: `http://127.0.0.1:${port}`,
      referer: `http://127.0.0.1:${port}/a?b`,
    });
    expect(seen[1]?.origin).toBe("http://evil.example");
    expect(t.bodyOf(1).toString()).toBe("ok");
  });

  it("keeps every cookie on the computer, lets the jar win, and logs out", async () => {
    const seen: Array<string | undefined> = [];
    const port = await serve((req, res) => {
      seen.push(req.headers.cookie);
      if (req.url === "/login")
        res.setHeader("Set-Cookie", ["session=abc; Path=/; HttpOnly", "theme=dark"]);
      if (req.url === "/logout") res.setHeader("Set-Cookie", "session=; Max-Age=0; Path=/");
      res.end();
    });
    const t = harness();
    t.receive(open(1, port, { path: "/login" }));
    await t.until(() => t.finished(1));
    expect(header(t.headOf(1), "set-cookie")).toBeUndefined();
    // The page's own cookies, and the door's key, arrive from the phone.
    t.receive(
      open(3, port, {
        headers: [h("Host", DOOR), h("Cookie", "__sb_41000=key; session=forged; js=1")],
      }),
    );
    await t.until(() => t.finished(3));
    expect(seen[1]).toBe("session=abc; theme=dark; js=1");
    t.receive(open(5, port, { path: "/logout" }));
    await t.until(() => t.finished(5));
    t.receive(open(7, port));
    await t.until(() => t.finished(7));
    expect(seen[3]).toBe("theme=dark");
  });

  it("adds anti-forgery headers only to same-origin non-GET requests, never over the page's own", async () => {
    const seen: http.IncomingHttpHeaders[] = [];
    const port = await serve((req, res) => {
      seen.push(req.headers);
      if (req.url === "/start") res.setHeader("Set-Cookie", "_xsrf=tok; Path=/");
      res.end();
    });
    const t = harness();
    const origin = h("Origin", `http://${DOOR}`);
    t.receive(open(1, port, { path: "/start" }));
    await t.until(() => t.finished(1));
    t.receive(open(3, port, { method: "POST", headers: [h("Host", DOOR), origin] }));
    t.receive(open(5, port, { method: "GET", headers: [h("Host", DOOR), origin] }));
    t.receive(
      open(7, port, {
        method: "POST",
        headers: [h("Host", DOOR), h("Origin", "http://evil.example")],
      }),
    );
    t.receive(
      open(9, port, {
        method: "POST",
        headers: [h("Host", DOOR), origin, h("X-XSRFToken", "mine")],
      }),
    );
    await t.until(() => [3, 5, 7, 9].every((s) => t.finished(s)));
    // Only the two same-origin POSTs carry it: one filled in, one the page's own.
    expect(
      seen
        .map((s) => s["x-xsrftoken"])
        .filter(Boolean)
        .sort(),
    ).toEqual(["mine", "tok"]);
    expect(seen.find((s) => s.origin === "http://evil.example")?.["x-xsrftoken"]).toBeUndefined();
  });

  it("maps a redirect on this page to the door, and sends any other through leave", async () => {
    const port = await serve((req, res) => {
      const to: Record<string, string> = {
        "/same": `http://127.0.0.1:${req.socket.localPort}/x?y`,
        "/alias": `http://localhost:${req.socket.localPort}/z`,
        "/other": "http://127.0.0.1:5181/landing",
        "/public": "https://example.com/r",
        "/relative": "/next",
      };
      res.writeHead(302, { Location: to[req.url ?? ""] ?? "/" }).end();
    });
    const t = harness();
    for (const [i, path] of ["/same", "/alias", "/other", "/public", "/relative"].entries())
      t.receive(open(2 * i + 1, port, { path }));
    await t.until(() => [1, 3, 5, 7, 9].every((s) => t.finished(s)));
    expect([1, 3, 5, 7, 9].map((s) => header(t.headOf(s), "location"))).toEqual([
      "/x?y",
      "/z",
      `/__shellbell/leave?to=${encodeURIComponent("http://127.0.0.1:5181/landing")}`,
      `/__shellbell/leave?to=${encodeURIComponent("https://example.com/r")}`,
      "/next",
    ]);
  });

  it("removes HSTS and hop-by-hop headers, and ends HEAD, 204 and 304 in the head", async () => {
    const port = await serve((req, res) => {
      if (req.url === "/204") return res.writeHead(204).end();
      if (req.url === "/304") return res.writeHead(304).end();
      res.writeHead(200, {
        "Strict-Transport-Security": "max-age=1",
        "Keep-Alive": "timeout=5",
        "X-Kept": "1",
      });
      res.end("body");
    });
    const t = harness();
    t.receive(open(1, port, { method: "HEAD" }));
    t.receive(open(3, port, { path: "/204" }));
    t.receive(open(5, port, { path: "/304" }));
    t.receive(open(7, port));
    await t.until(() => [1, 3, 5, 7].every((s) => t.finished(s)));
    for (const s of [1, 3, 5]) expect(t.headOf(s)?.end).toBe(true);
    const head = t.headOf(7);
    expect(header(head, "strict-transport-security")).toBeUndefined();
    expect(header(head, "keep-alive")).toBeUndefined();
    expect(header(head, "connection")).toBeUndefined();
    expect(header(head, "x-kept")).toBe("1");
  });

  it("delivers a body that arrives before the target connects, in order", async () => {
    let received = "";
    const port = await serve((req, res) => {
      req.on("data", (c) => (received += c));
      req.on("end", () => res.end(`got ${received.length}`));
    });
    const t = harness();
    t.receive(open(1, port, { method: "POST", body: true }));
    t.receive({ type: "web.data", stream: 1, bytes: headerBytes("hello ") });
    t.receive({ type: "web.data", stream: 1, bytes: headerBytes("world") });
    t.receive({ type: "web.end", stream: 1 });
    await t.until(() => t.finished(1));
    expect(received).toBe("hello world");
    expect(t.bodyOf(1).toString()).toBe("got 11");
  });

  it("never completes a POST whose end didn't arrive before the phone went away", async () => {
    const outcome = vi.fn();
    const port = await serve((req, res) => {
      req.on("end", () => outcome("complete"));
      req.on("aborted", () => outcome("aborted"));
      req.on("close", () => outcome("close"));
      req.resume();
      res.on("close", () => {});
    });
    const t = harness();
    t.receive(
      open(1, port, {
        method: "POST",
        body: true,
        headers: [h("Host", DOOR), h("Content-Length", "20")],
      }),
    );
    t.receive({ type: "web.data", stream: 1, bytes: headerBytes("0123456789") });
    await new Promise((r) => setTimeout(r, 100));
    t.host.close();
    await vi.waitFor(() => expect(outcome).toHaveBeenCalledWith("close"));
    expect(outcome).not.toHaveBeenCalledWith("complete");
  });

  it("tries IPv4 then IPv6 for localhost, and keeps numeric families", async () => {
    const port = await serve((_req, res) => res.end("six"), "::1");
    const t = harness();
    t.receive(open(1, port, {}, "localhost"));
    t.receive(open(3, port, {}, "127.0.0.1"));
    t.receive(open(5, port, {}, "[::1]"));
    await t.until(() => [1, 3, 5].every((s) => t.finished(s)));
    expect(t.bodyOf(1).toString()).toBe("six");
    expect(t.of(3).at(-1)).toMatchObject({ type: "web.reset", reason: "unreachable" });
    expect(t.bodyOf(5).toString()).toBe("six");
  });

  it("tells the phone the page's authority and family once after it opens the view", async () => {
    const port = await serve((_req, res) => res.end());
    const t = harness();
    t.receive({ type: "web.view", target: { origin: `http://localhost:${port}` }, open: true });
    t.receive(open(1, port, {}, "localhost"));
    await t.until(() => t.finished(1));
    t.receive(open(3, port, {}, "localhost"));
    await t.until(() => t.finished(3));
    expect(t.headOf(1)?.authority).toEqual({ authority: `localhost:${port}`, family: 4 });
    expect(t.headOf(3)?.authority).toBeUndefined();
  });

  it("refuses non-loopback targets, reused stream IDs and unknown pages", async () => {
    const port = await serve((_req, res) => res.end());
    const t = harness();
    t.receive({ ...open(1, port), target: { origin: "http://example.com" } });
    t.receive({ ...open(3, port), target: { page: "sous" } });
    t.receive(open(5, port));
    t.receive(open(5, port));
    await t.until(() => t.finished(5));
    expect(t.of(1)).toEqual([{ type: "web.reset", stream: 1, reason: "refused" }]);
    expect(t.of(3)).toEqual([{ type: "web.reset", stream: 3, reason: "not-found" }]);
    expect(t.of(5).filter((m) => m.type === "web.reset")).toEqual([
      { type: "web.reset", stream: 5, reason: "refused" },
    ]);
  });
});

describe("WebHost compression", () => {
  const js = "export const value = 42;\n".repeat(400);
  const gz = [h("Host", DOOR), h("Accept-Encoding", "gzip, deflate, br")];

  it("gzips uncompressed text, drops the length, varies, and weakens the ETag", async () => {
    const port = await serve((_req, res) => {
      res.writeHead(200, {
        "Content-Type": "text/javascript",
        "Content-Length": String(js.length),
        ETag: '"abc"',
        Vary: "Origin",
      });
      res.end(js);
    });
    const t = harness();
    t.receive(open(1, port, { headers: gz }));
    await t.until(() => t.finished(1));
    const head = t.headOf(1);
    expect(header(head, "content-encoding")).toBe("gzip");
    expect(header(head, "content-length")).toBeUndefined();
    expect(header(head, "vary")).toBe("Origin, Accept-Encoding");
    expect(header(head, "etag")).toBe('W/"abc"');
    const body = t.bodyOf(1);
    expect(gunzipSync(body).toString()).toBe(js);
    expect(body.byteLength).toBeLessThan(js.length / 10);
  });

  it("leaves alone what it shouldn't compress", async () => {
    const port = await serve((req, res) => {
      const cases: Record<string, http.OutgoingHttpHeaders> = {
        "/png": { "Content-Type": "image/png" },
        "/already": { "Content-Type": "text/javascript", "Content-Encoding": "br" },
        "/sse": { "Content-Type": "text/event-stream" },
        "/cookie": { "Content-Type": "text/html", "Set-Cookie": "s=1" },
        "/small": { "Content-Type": "text/html", "Content-Length": "5" },
        "/notransform": { "Content-Type": "text/html", "Cache-Control": "no-transform" },
      };
      if (req.url === "/small") return res.writeHead(200, cases["/small"]).end("small");
      res.writeHead(
        req.url === "/partial" ? 206 : 200,
        cases[req.url ?? ""] ?? { "Content-Type": "text/html" },
      );
      res.end(js);
    });
    const t = harness();
    const paths = ["/png", "/already", "/sse", "/cookie", "/small", "/notransform", "/partial"];
    for (const [i, path] of paths.entries())
      t.receive(open(2 * i + 1, port, { path, headers: gz }));
    t.receive(open(99, port, { path: "/plain" })); // the page view didn't offer gzip
    await t.until(() => [...paths.map((_, i) => 2 * i + 1), 99].every((s) => t.finished(s)));
    for (const s of [...paths.map((_, i) => 2 * i + 1), 99])
      expect(header(t.headOf(s), "content-encoding") ?? "none", String(s)).not.toBe("gzip");
  });
});

describe("WebHost WebSockets", () => {
  it("restores the upgrade, delivers bytes after the 101, and carries data both ways", async () => {
    const port = await serve(
      () => {},
      "127.0.0.1",
      (server) =>
        server.on("upgrade", (req, socket) => {
          const accept = createHash("sha1")
            .update(`${req.headers["sec-websocket-key"]}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`)
            .digest("base64");
          socket.write(
            `HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\nhello-after-101`,
          );
          socket.on("data", (d) => socket.write(`echo:${d}`));
        }),
    );
    const t = harness();
    t.receive(
      open(1, port, {
        upgrade: true,
        headers: [
          h("Host", DOOR),
          h("Connection", "Upgrade"),
          h("Upgrade", "websocket"),
          h("Sec-WebSocket-Key", "dGhlIHNhbXBsZSBub25jZQ=="),
          h("Sec-WebSocket-Version", "13"),
        ],
      }),
    );
    // The page sends at once, before the 101 has arrived.
    t.receive({ type: "web.data", stream: 1, bytes: headerBytes("ping") });
    await t.until(() => t.bodyOf(1).toString().includes("echo:ping"));
    const head = t.headOf(1);
    expect(head?.status).toBe(101);
    expect(header(head, "sec-websocket-accept")).toBeDefined();
    expect(t.bodyOf(1).toString()).toBe("hello-after-101echo:ping");
    t.receive({ type: "web.reset", stream: 1, reason: "closed" });
    expect(t.host.openStreams).toBe(0);
  });
});

describe("WebHost credit", () => {
  it("retires the shared route after invalid credit instead of resetting one peer", () => {
    const fault = vi.fn();
    const host = new WebHost({
      phoneFp: "phone",
      jars: new CookieJars(),
      send: () => true,
      fault,
      log: { info() {}, warn() {} },
    });
    hosts.push(host);
    const message: WebMessage = { type: "web.credit", stream: 0, bytes: 1 };
    host.receive(message, encodeCbor(message).byteLength);
    host.receive(message, encodeCbor(message).byteLength);
    expect(host.openStreams).toBe(0);
    expect(fault).toHaveBeenCalledTimes(1);
  });
  it("times out a draining response whose peer stops returning credit", async () => {
    const callbacks = new Map<() => void, number>();
    let ended = false;
    const original = http.request;
    const spy = vi.spyOn(http, "request").mockImplementation(((...args: unknown[]) => {
      const req = Reflect.apply(original, http, args) as http.ClientRequest;
      req.on("response", (res) =>
        res.on("end", () => {
          ended = true;
        }),
      );
      return req;
    }) as typeof http.request);
    try {
      const port = await serve((_req, res) => res.end(Buffer.alloc(150 * 1024)));
      const t = harness(new CookieJars(), {
        timeouts: { idleMs: 500 },
        timer: (callback, ms) => {
          callbacks.set(callback, ms);
          return () => callbacks.delete(callback);
        },
      });
      t.receive(open(1, port));
      await vi.waitFor(() => expect(ended).toBe(true));
      const draining = [...callbacks].filter(([, ms]) => ms === 500);
      expect(draining).toHaveLength(1);
      const callback = draining[0]![0];
      callbacks.delete(callback);
      callback();
      expect(t.host.openStreams).toBe(0);
      expect(t.of(1).at(-1)).toMatchObject({ type: "web.reset", reason: "timeout" });
    } finally {
      spy.mockRestore();
    }
  });
  it("counts draining responses against the 24-stream limit", async () => {
    let ended = 0,
      requests = 0;
    const original = http.request;
    const spy = vi.spyOn(http, "request").mockImplementation(((...args: unknown[]) => {
      const req = Reflect.apply(original, http, args) as http.ClientRequest;
      req.on("response", (res) =>
        res.on("end", () => {
          ended++;
        }),
      );
      return req;
    }) as typeof http.request);
    try {
      const port = await serve((_req, res) => {
        requests++;
        res.end(Buffer.alloc(150 * 1024));
      });
      const t = harness();
      let returned = 0;
      const credit = () => {
        const charged = t.sent.reduce(
          (n, m) =>
            n +
            (m.type === "web.head" || m.type === "web.data" ? encodeCbor(m).byteLength + 256 : 0),
          0,
        );
        if (charged > returned) {
          const delta = charged - returned;
          returned = charged;
          t.receive({ type: "web.credit", stream: 0, bytes: delta });
        }
      };
      for (let stream = 1; stream <= 24; stream++) {
        t.receive(open(stream, port));
        await t.until(() => {
          credit();
          return ended === stream;
        });
      }
      expect(t.host.openStreams).toBe(24);
      t.receive(open(25, port));
      expect(t.of(25)).toContainEqual({ type: "web.reset", stream: 25, reason: "refused" });
      expect(requests).toBe(24);
      for (let stream = 1; stream <= 24; stream++)
        t.receive({ type: "web.reset", stream, reason: "closed" });
      expect(t.host.openStreams).toBe(0);
    } finally {
      spy.mockRestore();
    }
  });
  it("owns a completed response until draining, and cancellation discards unsent data", async () => {
    let upstreamEnded = false;
    const original = http.request;
    const spy = vi.spyOn(http, "request").mockImplementation(((...args: unknown[]) => {
      const req = Reflect.apply(original, http, args) as http.ClientRequest;
      req.on("response", (res) =>
        res.on("end", () => {
          upstreamEnded = true;
        }),
      );
      return req;
    }) as typeof http.request);
    try {
      const port = await serve((_req, res) => res.end(Buffer.alloc(150 * 1024, 7)));
      const t = harness();
      t.receive(open(1, port));
      await vi.waitFor(() => expect(upstreamEnded).toBe(true));
      expect(t.host.openStreams).toBe(1);
      t.receive({ type: "web.reset", stream: 1, reason: "closed" });
      expect(t.host.openStreams).toBe(0);
      const bytes = t.bodyOf(1).length;
      const charged = t.sent.reduce(
        (n, m) =>
          n + (m.type === "web.head" || m.type === "web.data" ? encodeCbor(m).byteLength + 256 : 0),
        0,
      );
      t.receive({ type: "web.credit", stream: 0, bytes: charged });
      t.receive({ type: "web.credit", stream: 1, bytes });
      expect(t.bodyOf(1)).toHaveLength(bytes);
      expect(t.of(1).some((m) => m.type === "web.end")).toBe(false);
    } finally {
      spy.mockRestore();
    }
  });
  it("streams a large body as credit returns, and an undecodable frame still returns credit", async () => {
    const size = 1_000_000;
    const port = await serve((_req, res) => res.end(Buffer.alloc(size, 7)));
    const t = harness();
    t.receive(open(1, port));
    let delivered = 0;
    let returned = 0;
    await t.until(() => {
      const data = t.of(1).filter((m): m is WebMessageOf<"web.data"> => m.type === "web.data");
      const total = data.reduce((s, m) => s + m.bytes.byteLength, 0);
      if (total > delivered) {
        const charge = t.sent.reduce(
          (s, m) =>
            s +
            (m.type === "web.data" || m.type === "web.head" ? encodeCbor(m).byteLength + 256 : 0),
          0,
        );
        // Return everything sent so far, as a phone that read it would.
        t.receive({ type: "web.credit", stream: 0, bytes: charge - returned });
        returned = charge;
        t.receive({ type: "web.credit", stream: 1, bytes: total - delivered });
        delivered = total;
      }
      return t.finished(1);
    }, 10_000);
    expect(t.bodyOf(1).byteLength).toBe(size);
    // Every charged frame the phone sent (the open, and one it couldn't decode) comes back.
    t.host.undecodable(500);
    const expected = encodeCbor(open(1, port)).byteLength + 256 + 500 + 256;
    const returnedToPhone = () =>
      t.sent.reduce((s, m) => s + (m.type === "web.credit" && m.stream === 0 ? m.bytes : 0), 0);
    await t.until(() => returnedToPhone() === expected);
  });

  it("resets every stream when the phone returns more credit than was spent", async () => {
    const port = await serve(() => {}); // never answers
    const t = harness();
    t.receive(open(1, port));
    t.receive(open(3, port));
    t.receive({ type: "web.credit", stream: 0, bytes: 10 });
    expect(t.of(1).at(-1)).toMatchObject({ type: "web.reset", reason: "closed" });
    expect(t.of(3).at(-1)).toMatchObject({ type: "web.reset", reason: "closed" });
  });
});

describe("CookieJar", () => {
  it("handles paths, expiry, replacement and host-only scope", () => {
    const jar = new CookieJar(0);
    jar.store("a=1; Path=/app", "/", 0);
    jar.store("b=2", "/app/page", 0); // default path /app
    jar.store("c=3; Max-Age=10", "/", 0);
    jar.store("d=4; Expires=Thu, 01 Jan 1970 00:00:05 GMT", "/", 0);
    jar.store("__Host-x=5; Path=/app", "/", 0); // refused: __Host- needs Path=/
    expect(jar.matching("/app/x", 1000)).toEqual([
      ["a", "1"],
      ["b", "2"],
      ["c", "3"],
      ["d", "4"],
    ]);
    expect(jar.matching("/apple", 1000).map(([n]) => n)).toEqual(["c", "d"]);
    expect(jar.matching("/", 6000).map(([n]) => n)).toEqual(["c"]);
    jar.store("c=new", "/", 7000);
    expect(jar.matching("/", 20_000)).toEqual([["c", "new"]]);
  });

  it("keeps hosts and phones apart, and drops idle jars", () => {
    let now = 0;
    const jars = new CookieJars(() => now);
    jars.jar("p1", "alice.localhost").store("s=a", "/", now);
    jars.jar("p1", "bob.localhost").store("s=b", "/", now);
    jars.jar("p2", "alice.localhost").store("s=c", "/", now);
    expect(jars.jar("p1", "alice.localhost").matching("/", now)).toEqual([["s", "a"]]);
    expect(jars.jar("p1", "bob.localhost").matching("/", now)).toEqual([["s", "b"]]);
    jars.dropPhone("p2");
    expect(jars.jar("p2", "alice.localhost").size).toBe(0);
    now = 25 * 60 * 60 * 1000;
    expect(jars.jar("p1", "alice.localhost").size).toBe(0);
  });
});

describe("rewriteLocation", () => {
  const target = {
    origin: "http://localhost:3000",
    authority: "localhost:3000",
    host: { kind: "name", name: "localhost" },
    port: 3000,
  } as const;
  it("keeps same-family aliases and sends the other family through leave", () => {
    expect(rewriteLocation("http://127.0.0.1:3000/a", { target, family: 4 })).toBe("/a");
    expect(rewriteLocation("http://[::1]:3000/a", { target, family: 4 })).toMatch(
      /^\/__shellbell\/leave/,
    );
    expect(rewriteLocation("//127.0.0.1:3000/b", { target, family: 4 })).toBe("/b");
    expect(rewriteLocation("relative", { target, family: 4 })).toBe("relative");
  });
});
