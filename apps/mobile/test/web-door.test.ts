import {
  encodeCbor,
  type WebMessage,
  type WebMessageOf,
  type WebResetReason,
  webCharge,
} from "@shellbell/protocol";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { WebDoor } from "../src/web/door";
import { latin1, latin1Bytes } from "../src/web/http";
import { WebSession } from "../src/web/web-session";

type Listener = (e: { id: number; generation: number; bytes?: number }) => void;

/** Loopback sockets as the native module presents them, driven by the test as the web view. */
class FakeNative {
  listeners = new Map<string, Listener[]>();
  inbound = new Map<number, Uint8Array[]>();
  ended = new Set<number>();
  out = new Map<number, Uint8Array[]>();
  closed = new Set<number>();
  shut = new Set<number>();
  private next = 1;
  generation = 7;
  autoWritten = true;

  addListener(event: string, listener: Listener) {
    this.listeners.set(event, [...(this.listeners.get(event) ?? []), listener]);
    return { remove: () => this.listeners.set(event, []) };
  }
  emit(event: string, e: { id: number; bytes?: number; generation?: number }) {
    for (const l of this.listeners.get(event) ?? []) l({ generation: this.generation, ...e });
  }
  listen(): [number, number] {
    return [41000, this.generation];
  }
  stop = vi.fn();
  read(id: number, out: Uint8Array): number {
    const queue = this.inbound.get(id) ?? [];
    const head = queue.shift();
    if (!head) return this.ended.has(id) ? -1 : 0;
    const n = Math.min(head.length, out.length);
    out.set(head.subarray(0, n));
    if (n < head.length) queue.unshift(head.subarray(n));
    return n;
  }
  write(id: number, data: Uint8Array): boolean {
    if (this.closed.has(id)) return false;
    this.out.set(id, [...(this.out.get(id) ?? []), data.slice()]);
    if (this.autoWritten) queueMicrotask(() => this.emit("written", { id, bytes: data.length }));
    return true;
  }
  shutdownOutput(id: number) {
    this.shut.add(id);
  }
  close(id: number) {
    this.closed.add(id);
  }

  /** The web view opens a connection and sends `text`. */
  connect(text: string | Uint8Array): number {
    const id = this.next++;
    this.emit("accepted", { id });
    this.send(id, text);
    return id;
  }
  send(id: number, text: string | Uint8Array) {
    this.inbound.set(id, [
      ...(this.inbound.get(id) ?? []),
      typeof text === "string" ? latin1Bytes(text) : text,
    ]);
    this.emit("readable", { id });
  }
  response(id: number): string {
    return latin1(
      (this.out.get(id) ?? []).reduce((a, b) => {
        const c = new Uint8Array(a.length + b.length);
        c.set(a);
        c.set(b, a.length);
        return c;
      }, new Uint8Array(0)),
    );
  }
}

/** A computer that answers through the real session, as the agent's web host would. */
function setup() {
  const native = new FakeNative();
  const toComputer: WebMessage[] = [];
  const session = new WebSession({
    send: (m) => {
      toComputer.push(m);
      return true;
    },
  });
  const events = {
    leave: vi.fn(),
    blocked: vi.fn(),
    download: vi.fn(),
    failed: vi.fn(),
  };
  let available = true;
  let counter = 0;
  const door = new WebDoor({
    native: native as unknown as ConstructorParameters<typeof WebDoor>[0]["native"],
    target: { origin: "http://localhost:5173" },
    session: () => (available ? session : null),
    events,
    random: (n) => new Uint8Array(n).fill(++counter),
  });
  const reply = (m: WebMessage) => session.receive(m, encodeCbor(m).byteLength);
  const opens = () =>
    toComputer.filter((m): m is WebMessageOf<"web.open"> => m.type === "web.open");
  const enter = (path = "/") => {
    const url = new URL(door.enter(path));
    const id = native.connect(
      `GET ${url.pathname}${url.search} HTTP/1.1\r\nHost: 127.0.0.1:41000\r\n\r\n`,
    );
    const res = native.response(id);
    const cookie = /Set-Cookie: ([^;]+)/.exec(res)?.[1] ?? "";
    return { id, res, cookie };
  };
  const unavailable = () => {
    available = false;
  };
  return { native, door, session, toComputer, events, reply, opens, enter, unavailable };
}

const get = (path: string, cookie: string, extra = "") =>
  `GET ${path} HTTP/1.1\r\nHost: 127.0.0.1:41000\r\nCookie: ${cookie}\r\n${extra}\r\n`;
const h = (name: string, value: string): [string, Uint8Array] => [name, latin1Bytes(value)];

describe("WebDoor key", () => {
  it("spends the nonce once and sets an HttpOnly key that never appears in an address", () => {
    const t = setup();
    const url = t.door.enter("/app?x=1");
    expect(url).toMatch(/^http:\/\/127\.0\.0\.1:41000\/__shellbell\/enter\?n=/);
    const first = t.native.connect(
      `GET ${new URL(url).pathname}${new URL(url).search} HTTP/1.1\r\nHost: 127.0.0.1:41000\r\n\r\n`,
    );
    const res = t.native.response(first);
    expect(res).toMatch(/^HTTP\/1\.1 302/);
    expect(res).toMatch(/Set-Cookie: __sb_41000=[\w-]+; HttpOnly; SameSite=Strict; Path=\//);
    expect(res).toContain('Clear-Site-Data: "cache", "storage"');
    expect(res).toContain("Location: /app?x=1");
    const key = /__sb_41000=([\w-]+)/.exec(res)?.[1] ?? "";
    expect(url).not.toContain(key);
    // The same nonce again is refused.
    const again = t.native.connect(
      `GET ${new URL(url).pathname}${new URL(url).search} HTTP/1.1\r\nHost: 127.0.0.1:41000\r\n\r\n`,
    );
    expect(t.native.response(again)).toMatch(/^HTTP\/1\.1 403/);
  });

  it("refuses requests without the key or with another Host, without opening a stream", () => {
    const t = setup();
    const { cookie } = t.enter();
    const none = t.native.connect(get("/", "other=1"));
    const fake = t.native.connect(get("/", "__sb_41000=forged"));
    const host = t.native.connect(
      `GET / HTTP/1.1\r\nHost: localhost:41000\r\nCookie: ${cookie}\r\n\r\n`,
    );
    for (const id of [none, fake, host]) expect(t.native.response(id)).toMatch(/^HTTP\/1\.1 403/);
    expect(t.opens()).toEqual([]);
  });

  it("refuses service workers with Vary, and turns leave into an event", () => {
    const t = setup();
    const { cookie } = t.enter();
    const sw = t.native.connect(get("/sw.js", cookie, "Service-Worker: script\r\n"));
    expect(t.native.response(sw)).toMatch(/^HTTP\/1\.1 403[\s\S]*Vary: Service-Worker/);
    const leave = t.native.connect(
      get(
        `/__shellbell/leave?to=${encodeURIComponent("https://example.com/x")}`,
        cookie,
        "Sec-Fetch-Dest: document\r\n",
      ),
    );
    expect(t.native.response(leave)).toMatch(/^HTTP\/1\.1 204/);
    expect(t.events.leave).toHaveBeenCalledWith("https://example.com/x", true);
    expect(t.opens()).toEqual([]);
  });

  it("answers 503 while the computer can't take requests", () => {
    const t = setup();
    const { cookie } = t.enter();
    t.unavailable();
    const id = t.native.connect(get("/", cookie));
    expect(t.native.response(id)).toMatch(/^HTTP\/1\.1 503/);
  });
});

describe("WebDoor requests", () => {
  let t: ReturnType<typeof setup>;
  let cookie: string;
  beforeEach(() => {
    t = setup();
    cookie = t.enter().cookie;
  });
  it("cancels the remaining upload on early response and frees repeated request slots", () => {
    for (let n = 0; n < 30; n++) {
      t.native.connect(
        `POST / HTTP/1.1\r\nHost: 127.0.0.1:41000\r\nCookie: ${cookie}\r\nContent-Length: 1000\r\n\r\nx`,
      );
      const open = t.opens().at(-1)!;
      t.reply({ type: "web.head", stream: open.stream, status: 413, headers: [], end: true });
      expect(t.session.streams).toBe(0);
    }
    expect(t.opens()).toHaveLength(30);
    expect(t.toComputer.filter((m) => m.type === "web.reset")).toHaveLength(30);
    t.door.stop();
  });
  it("resumes a keep-alive socket after cancelling a fully buffered upload", () => {
    const header = (size: number) =>
      `POST / HTTP/1.1\r\nHost: 127.0.0.1:41000\r\nCookie: ${cookie}\r\nContent-Length: ${size}\r\n\r\n`;
    const size = 12 * 16384 - latin1Bytes(header(100000)).length;
    const id = t.native.connect(header(size) + "x".repeat(size));
    const first = t.opens()[0]!;
    t.reply({ type: "web.head", stream: first.stream, status: 200, headers: [], end: true });
    expect(t.session.streams).toBe(0);
    expect(t.native.closed.has(id)).toBe(false);
    t.native.send(id, get("/next", cookie));
    t.reply({
      type: "web.credit",
      stream: 0,
      bytes: t.toComputer.reduce((n, m) => n + webCharge(m), 0),
    });
    expect(t.opens().at(-1)?.path).toBe("/next");
    t.door.stop();
  });
  it("treats ordinary HTTP EOF as cancellation but preserves WebSocket half-close", () => {
    const id = t.native.connect(get("/", cookie));
    const first = t.opens()[0]!;
    t.native.ended.add(id);
    t.native.emit("readable", { id });
    expect(t.toComputer.at(-1)).toMatchObject({ type: "web.reset", stream: first.stream });
    const ws = t.native.connect(
      get("/ws", cookie, "Connection: Upgrade\r\nUpgrade: websocket\r\n"),
    );
    const second = t.opens().at(-1)!;
    t.reply({ type: "web.head", stream: second.stream, status: 101, headers: [] });
    t.native.ended.add(ws);
    t.native.emit("readable", { id: ws });
    expect(t.toComputer.at(-1)).toEqual({ type: "web.end", stream: second.stream });
    expect(t.native.closed.has(ws)).toBe(false);
    t.reply({ type: "web.data", stream: second.stream, bytes: latin1Bytes("last") });
    expect(t.native.response(ws)).toContain("last");
    t.reply({ type: "web.end", stream: second.stream });
    t.door.stop();
  });
  it("cancels work through its original session while keeping the door on pause", () => {
    t.native.connect(get("/", cookie));
    const first = t.opens()[0]!;
    t.unavailable();
    t.door.pause();
    expect(t.toComputer.at(-1)).toMatchObject({ type: "web.reset", stream: first.stream });
    expect(t.session.streams).toBe(0);
    expect(t.native.stop).not.toHaveBeenCalled();
    t.door.stop();
  });

  it("opens a stream with the page's headers and frames a sized response", () => {
    const id = t.native.connect(get("/index.html", `${cookie}; js=1`, "Accept: text/html\r\n"));
    const [open] = t.opens();
    expect(open).toMatchObject({
      target: { origin: "http://localhost:5173" },
      method: "GET",
      path: "/index.html",
      body: false,
      upgrade: false,
    });
    expect(open?.headers.map(([n]) => n)).toContain("Cookie");
    t.reply({
      type: "web.head",
      stream: open!.stream,
      status: 200,
      headers: [h("Content-Type", "text/html"), h("Content-Length", "5")],
    });
    t.reply({ type: "web.data", stream: open!.stream, bytes: latin1Bytes("hello") });
    t.reply({ type: "web.end", stream: open!.stream });
    const res = t.native.response(id);
    expect(res).toMatch(/^HTTP\/1\.1 200 OK\r\n/);
    expect(res).toContain("Content-Length: 5");
    expect(res).toContain("Content-Security-Policy: default-src 'self' http://127.0.0.1:41000");
    expect(res).toContain("worker-src 'self' blob:");
    expect(res).toContain("Vary: Service-Worker");
    expect(res.endsWith("\r\n\r\nhello")).toBe(true);
  });

  it("chunks a streamed response and serves the next request on the same connection", () => {
    const id = t.native.connect(get("/events", cookie));
    const s1 = t.opens()[0]!.stream;
    t.reply({
      type: "web.head",
      stream: s1,
      status: 200,
      headers: [h("Content-Type", "text/event-stream")],
    });
    t.reply({ type: "web.data", stream: s1, bytes: latin1Bytes("data: a\n\n") });
    t.reply({ type: "web.end", stream: s1 });
    expect(t.native.response(id)).toContain("Transfer-Encoding: chunked\r\n");
    expect(t.native.response(id)).toContain("9\r\ndata: a\n\n\r\n0\r\n\r\n");
    t.native.send(id, get("/second", cookie));
    expect(t.opens().map((o) => o.path)).toEqual(["/events", "/second"]);
    const s2 = t.opens()[1]!.stream;
    t.reply({ type: "web.head", stream: s2, status: 204, headers: [], end: true });
    expect(t.native.response(id)).toMatch(
      /HTTP\/1\.1 204 No Content\r\n(?:(?!Content-Length).)*\r\n\r\n$/s,
    );
    expect(t.native.closed.has(id)).toBe(false);
  });

  it("sends a body that arrives in separate packets, including after the head", () => {
    const id = t.native.connect(
      `POST /api HTTP/1.1\r\nHost: 127.0.0.1:41000\r\nCookie: ${cookie}\r\nContent-Length: 11\r\n\r\nhello`,
    );
    t.native.send(id, " world");
    const open = t.opens()[0]!;
    expect(open.body).toBe(true);
    const data = t.toComputer.filter((m): m is WebMessageOf<"web.data"> => m.type === "web.data");
    expect(data.map((m) => latin1(m.bytes)).join("")).toBe("hello world");
    expect(t.toComputer.at(-1)).toEqual({ type: "web.end", stream: open.stream });
  });

  it("decodes a chunked request body", () => {
    t.native.connect(
      `POST /up HTTP/1.1\r\nHost: 127.0.0.1:41000\r\nCookie: ${cookie}\r\nTransfer-Encoding: chunked\r\n\r\n5\r\nhello\r\n0\r\n\r\n`,
    );
    const data = t.toComputer.filter((m): m is WebMessageOf<"web.data"> => m.type === "web.data");
    expect(data.map((m) => latin1(m.bytes)).join("")).toBe("hello");
    expect(t.toComputer.at(-1)?.type).toBe("web.end");
  });

  it("carries a WebSocket both ways, including bytes the page sends before the 101", () => {
    const id = t.native.connect(
      `GET /ws HTTP/1.1\r\nHost: 127.0.0.1:41000\r\nCookie: ${cookie}\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n\r\nearly`,
    );
    const open = t.opens()[0]!;
    expect(open.upgrade).toBe(true);
    expect(open.body).toBe(false);
    t.reply({
      type: "web.head",
      stream: open.stream,
      status: 101,
      headers: [h("Sec-WebSocket-Accept", "x")],
      bytes: latin1Bytes("hi"),
    });
    t.native.send(id, "more");
    t.reply({ type: "web.data", stream: open.stream, bytes: latin1Bytes("echo") });
    const res = t.native.response(id);
    expect(res).toMatch(
      /^HTTP\/1\.1 101[\s\S]*Connection: Upgrade\r\n[\s\S]*Upgrade: websocket\r\n/,
    );
    expect(res.endsWith("\r\n\r\nhiecho")).toBe(true);
    const data = t.toComputer.filter((m): m is WebMessageOf<"web.data"> => m.type === "web.data");
    expect(data.map((m) => latin1(m.bytes)).join("")).toBe("earlymore");
    t.reply({ type: "web.end", stream: open.stream });
    expect(t.native.shut.has(id)).toBe(true);
  });

  it("refuses downloads and resets the stream", () => {
    const id = t.native.connect(get("/file", cookie, "Sec-Fetch-Dest: document\r\n"));
    const open = t.opens()[0]!;
    t.reply({
      type: "web.head",
      stream: open.stream,
      status: 200,
      headers: [h("Content-Type", "application/zip")],
    });
    expect(t.native.response(id)).toMatch(/^HTTP\/1\.1 204/);
    expect(t.events.download).toHaveBeenCalled();
    expect(t.toComputer.at(-1)).toEqual({
      type: "web.reset",
      stream: open.stream,
      reason: "closed",
    });

    const second = t.native.connect(get("/report.csv", cookie));
    const open2 = t.opens()[1]!;
    t.reply({
      type: "web.head",
      stream: open2.stream,
      status: 200,
      headers: [h("Content-Disposition", "attachment; filename=r.csv")],
    });
    expect(t.native.response(second)).toMatch(/^HTTP\/1\.1 204/);
  });

  it("shows a failed navigation and cuts a response that was under way", () => {
    const doc = t.native.connect(get("/", cookie, "Sec-Fetch-Dest: document\r\n"));
    const s1 = t.opens()[0]!.stream;
    t.reply({ type: "web.reset", stream: s1, reason: "unreachable" as WebResetReason });
    expect(t.native.response(doc)).toMatch(/^HTTP\/1\.1 502/);
    expect(t.events.failed).toHaveBeenCalledWith("unreachable", undefined);

    const img = t.native.connect(get("/big.png", cookie));
    const s2 = t.opens()[1]!.stream;
    t.reply({ type: "web.head", stream: s2, status: 200, headers: [h("Content-Length", "100")] });
    t.reply({ type: "web.reset", stream: s2, reason: "closed" });
    expect(t.native.closed.has(img)).toBe(true);
    expect(t.events.failed).toHaveBeenCalledTimes(1);
  });

  it("resets the stream when the web view gives up on a request", () => {
    const id = t.native.connect(get("/slow", cookie));
    const open = t.opens()[0]!;
    t.native.emit("closed", { id });
    expect(t.toComputer.at(-1)).toEqual({
      type: "web.reset",
      stream: open.stream,
      reason: "closed",
    });
  });

  it("returns stream credit as the web view takes body bytes", async () => {
    const id = t.native.connect(get("/blob", cookie));
    const open = t.opens()[0]!;
    t.reply({
      type: "web.head",
      stream: open.stream,
      status: 200,
      headers: [h("Content-Length", "9000")],
    });
    t.reply({ type: "web.data", stream: open.stream, bytes: new Uint8Array(9000) });
    await new Promise((r) => setTimeout(r, 0));
    expect(t.toComputer).toContainEqual({ type: "web.credit", stream: open.stream, bytes: 9000 });
    expect(t.native.response(id).length).toBeGreaterThan(9000);
  });

  it("ignores events from an older door on the same module", () => {
    t.native.generation = 8; // a newer listen
    t.native.connect(get("/", cookie));
    expect(t.opens()).toEqual([]);
  });

  it("stops listening and resets open streams", () => {
    t.native.connect(get("/hang", cookie));
    const open = t.opens()[0]!;
    t.door.stop();
    expect(t.native.stop).toHaveBeenCalled();
    expect(t.toComputer.at(-1)).toEqual({
      type: "web.reset",
      stream: open.stream,
      reason: "closed",
    });
  });
});

describe("WebSession", () => {
  it("notifies the route owner exactly once on a fatal credit error", () => {
    const failed = vi.fn(),
      closed = vi.fn();
    const session = new WebSession({ send: () => true, failed, closed });
    const invalid: WebMessage = { type: "web.credit", stream: 0, bytes: 1 };
    session.receive(invalid, encodeCbor(invalid).byteLength);
    session.receive(invalid, encodeCbor(invalid).byteLength);
    expect(session.closed).toBe(true);
    expect(failed).toHaveBeenCalledTimes(1);
    expect(closed).toHaveBeenCalledTimes(1);
    const normal = new WebSession({ send: () => true, failed });
    normal.close();
    expect(failed).toHaveBeenCalledTimes(1);
  });
  it("returns connection credit without retaining late cancelled response bodies", () => {
    const sent: WebMessage[] = [];
    const session = new WebSession({
      send: (m) => {
        sent.push(m);
        return true;
      },
    });
    const id = session.open(
      {
        target: { origin: "http://localhost:1" },
        method: "GET",
        path: "/",
        headers: [],
        body: false,
        upgrade: false,
      },
      { head() {}, data() {}, end() {}, reset() {} },
    )!;
    session.reset(id);
    for (let n = 0; n < 12; n++) {
      const message: WebMessage = { type: "web.data", stream: id, bytes: new Uint8Array(16384) };
      session.receive(message, encodeCbor(message).byteLength);
    }
    expect(session.closed).toBe(false);
    expect(session.streams).toBe(0);
    expect(sent.some((m) => m.type === "web.credit" && m.stream === 0)).toBe(true);
    expect(sent.some((m) => m.type === "web.credit" && m.stream === id)).toBe(false);
    session.close();
  });
  it("releases a fully buffered upload when its final frames drain after the response", () => {
    const session = new WebSession({ send: () => true });
    const id = session.open(
      {
        target: { origin: "http://localhost:1" },
        method: "POST",
        path: "/",
        headers: [],
        body: true,
        upgrade: false,
      },
      { head() {}, data() {}, end() {}, reset() {} },
    )!;
    session.write(id, new Uint8Array(150 * 1024));
    session.end(id);
    const reply = (m: WebMessage) => session.receive(m, encodeCbor(m).byteLength);
    reply({ type: "web.head", stream: id, status: 200, headers: [], end: true });
    expect(session.streams).toBe(1);
    reply({ type: "web.credit", stream: id, bytes: 131072 });
    // Return charged bytes in small valid increments; the connection window,
    // not a hard-coded CBOR encoding length, is what controls completion.
    for (let n = 0; session.sending(id) && n < 10; n++)
      reply({ type: "web.credit", stream: 0, bytes: 16384 });
    expect(session.sending(id)).toBe(false);
    expect(session.streams).toBe(0);
    session.close();
  });
  it("keeps sequence and credit across local refusal on the same route", () => {
    let refused = false;
    const sent: WebMessage[] = [];
    const session = new WebSession({
      send: (m) => {
        if (refused && m.type === "web.open") return "refused";
        sent.push(m);
        return true;
      },
    });
    const open = {
      target: { origin: "http://localhost:1" },
      method: "GET",
      path: "/",
      headers: [],
      body: false,
      upgrade: false,
    };
    const handler = { head() {}, data() {}, end() {}, reset() {} };
    expect(session.open(open, handler)).toBe(1);
    refused = true;
    expect(session.open(open, handler)).toBeNull();
    expect(session.closed).toBe(false);
    refused = false;
    expect(session.open(open, handler)).toBe(3);
    expect(sent.filter((m) => m.type === "web.open").map((m) => m.stream)).toEqual([1, 3]);
    session.close();
  });
  it("resets every stream when it closes, and refuses new ones", () => {
    const resets: string[] = [];
    const session = new WebSession({ send: () => true });
    const handler = (name: string) => ({
      head: () => {},
      data: () => {},
      end: () => {},
      reset: (reason: string) => resets.push(`${name}:${reason}`),
    });
    const open = {
      target: { origin: "http://localhost:1" },
      method: "GET",
      path: "/",
      headers: [],
      body: true,
      upgrade: false,
    };
    session.open(open, handler("a"));
    session.open(open, handler("b"));
    session.close();
    expect(resets).toEqual(["a:closed", "b:closed"]);
    expect(session.open(open, handler("c"))).toBeNull();
  });

  it("closes when the route refuses a send, such as under App Lock", async () => {
    const closed = vi.fn();
    const session = new WebSession({ send: () => false, closed });
    session.open(
      {
        target: { origin: "http://localhost:1" },
        method: "GET",
        path: "/",
        headers: [],
        body: false,
        upgrade: false,
      },
      { head: () => {}, data: () => {}, end: () => {}, reset: () => {} },
    );
    await Promise.resolve();
    expect(closed).toHaveBeenCalled();
    expect(session.closed).toBe(true);
  });
});

describe("WebDoor links to this page under another name", () => {
  it("loads aliases in place once the computer says which family answered", () => {
    const t = setup();
    const cookie = t.enter().cookie;
    const door = `http://127.0.0.1:41000`;
    // Before any answer, only the name the page was opened with is this page.
    expect(t.door.inPage("http://localhost:5173/a?b=1#c")).toBe(`${door}/a?b=1#c`);
    expect(t.door.inPage("http://[::1]:5173/a")).toBeNull();

    t.native.connect(get("/", cookie));
    const [open] = t.opens();
    t.reply({
      type: "web.head",
      stream: open!.stream,
      status: 204,
      headers: [],
      end: true,
      authority: { authority: "localhost:5173", family: 6 },
    });
    expect(t.door.inPage("http://[::1]:5173/x")).toBe(`${door}/x`);
    expect(t.door.inPage("http://0.0.0.0:5173/")).toBe(`${door}/`);
    // Another family, port or name is another page; so are public and door-internal paths.
    expect(t.door.inPage("http://127.0.0.1:5173/x")).toBeNull();
    expect(t.door.inPage("http://localhost:5174/x")).toBeNull();
    expect(t.door.inPage("http://app.localhost:5173/x")).toBeNull();
    expect(t.door.inPage("https://example.com/")).toBeNull();
    expect(t.door.inPage("http://localhost:5173/__shellbell/leave?to=x")).toBeNull();
  });
});
