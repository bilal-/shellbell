import { createHash } from "node:crypto";
import http from "node:http";
import type { AddressInfo } from "node:net";
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
  server.on("connection", (socket) => server.once("close", () => socket.destroy()));
  server.on("upgrade", (_req, socket) => sockets.push(socket));
  setup?.(server);
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, host, resolve));
  return (server.address() as AddressInfo).port;
}

function harness(jars = new CookieJars()) {
  const sent: WebMessage[] = [];
  const waiters: Array<() => void> = [];
  const host = new WebHost({
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
    await new Promise((r) => setTimeout(r, 50));
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
