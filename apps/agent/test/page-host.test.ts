import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import http from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { encodeCbor, type WebMessage, type WebMessageOf } from "@shellbell/protocol";
import { afterEach, expect, it, vi } from "vitest";
import { CookieJars } from "../src/web/cookie-jar.js";
import { PageHost } from "../src/web/page-host.js";
import { pageFailureDetail } from "../src/web/page-processes.js";
import { WebHost } from "../src/web/web-host.js";

const homes: string[] = [],
  pages: PageHost[] = [],
  hosts: WebHost[] = [],
  servers: http.Server[] = [];
afterEach(async () => {
  for (const host of hosts.splice(0)) host.close();
  await Promise.all(pages.splice(0).map((p) => p.close()));
  for (const s of servers.splice(0)) {
    s.closeAllConnections();
    await new Promise<void>((r) => s.close(() => r()));
  }
  for (const h of homes.splice(0)) rmSync(h, { recursive: true, force: true });
});
function fixture(options: { idleMs?: number; startMs?: number; killMs?: number } = {}) {
  const home = mkdtempSync(join(tmpdir(), "shellbell-page-host-"));
  homes.push(home);
  const directory = join(home, ".config/shellbell/apps");
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const jars = new CookieJars(),
    pageHost = new PageHost({ home, platform: "linux", jars, ...options });
  pages.push(pageHost);
  const register = (id: string, value: unknown) => {
    writeFileSync(join(directory, `${id}.json`), JSON.stringify(value), { mode: 0o644 });
  };
  const script = (body: string) => {
    const p = join(home, "server.cjs");
    writeFileSync(p, body, { mode: 0o600 });
    return p;
  };
  return { home, directory, pageHost, jars, register, script };
}
function harness(pages: PageHost, phone = "phone", jars = new CookieJars()) {
  const sent: WebMessage[] = [];
  const host = new WebHost({
    pages,
    jars,
    phoneFp: phone,
    send: (m) => {
      sent.push(m);
      return true;
    },
    log: { info() {}, warn() {} },
  });
  hosts.push(host);
  const receive = (m: WebMessage) => host.receive(m, encodeCbor(m).byteLength);
  const view = (id = "board", open = true) =>
    receive({ type: "web.view", target: { page: id }, open });
  const open = (
    stream = 1,
    method = "GET",
    path = "/",
    body = false,
    headers: WebMessageOf<"web.open">["headers"] = [],
  ) =>
    receive({
      type: "web.open",
      stream,
      target: { page: "board" },
      method,
      path,
      body,
      upgrade: false,
      headers,
    });
  const wait = async (stream = 1) => {
    await vi.waitFor(() =>
      expect(
        sent.some(
          (m) => "stream" in m && m.stream === stream && ["web.end", "web.reset"].includes(m.type),
        ) || sent.some((m) => m.type === "web.head" && m.stream === stream && m.end),
      ).toBe(true),
    );
    return sent.filter((m) => "stream" in m && m.stream === stream);
  };
  return { host, sent, receive, view, open, wait };
}
const serverScript = `const http=require('node:http'),fs=require('node:fs');fs.writeFileSync('created.txt','created');fs.appendFileSync('starts.txt','start\\n');let logins=0,actions=0;const server=http.createServer((req,res)=>{if(req.url==='/?t=entry-secret'){logins++;res.writeHead(302,{'Set-Cookie':'login='+logins+'; HttpOnly; SameSite=Strict; Path=/','Location':'/'});res.end();return;}if(!req.headers.cookie?.includes('login=')){res.writeHead(403);res.end();return;}if(req.url==='/stats'){res.end(JSON.stringify({logins,actions,cookie:req.headers.cookie}));return;}if(req.method==='POST'){let body='';req.on('data',b=>body+=b);req.on('end',()=>{actions++;res.end(body)});return;}res.setHeader('Content-Type','text/html');res.end('<title>Board</title>Ready');});server.listen(0,'127.0.0.1',()=>console.log(JSON.stringify({url:'http://127.0.0.1:'+server.address().port+'/?t=entry-secret'})));`;
it("shares one started server, signs each phone in separately, and keeps the entry secret off the wire", async () => {
  const f = fixture();
  const program = f.script(serverScript);
  f.register("board", {
    shellbell: 1,
    name: "Board",
    start: [process.execPath, program],
    cwd: f.home,
  });
  await f.pageHost.start();
  const a = harness(f.pageHost, "a", f.jars),
    b = harness(f.pageHost, "b", f.jars);
  a.view();
  b.view();
  a.open();
  b.open();
  const [aa, bb] = await Promise.all([a.wait(), b.wait()]);
  expect(aa.some((m) => m.type === "web.head" && m.status === 200)).toBe(true);
  expect(bb.some((m) => m.type === "web.head" && m.status === 200)).toBe(true);
  expect(readFileSync(join(f.home, "starts.txt"), "utf8").trim().split("\n")).toHaveLength(1);
  expect(JSON.stringify([...a.sent, ...b.sent])).not.toContain("entry-secret");
  expect(
    [...a.sent, ...b.sent]
      .filter((m) => m.type === "web.head")
      .every((m) => m.headers.every(([name]) => name.toLowerCase() !== "set-cookie")),
  ).toBe(true);
  const instance = await f.pageHost
    .resolve("board", "a-test", "a", new AbortController().signal)
    .catch(() => null);
  expect(instance).toBeNull(); // Resolve does not start a page for a viewer that never opened it.
  expect((await import("node:fs")).statSync(join(f.home, "created.txt")).mode & 0o777).toBe(0o644);
});
it("authenticates before the second phone's first POST and holds its body until startup completes", async () => {
  const f = fixture();
  f.register("board", {
    shellbell: 1,
    name: "Board",
    start: [process.execPath, f.script(serverScript)],
    cwd: f.home,
  });
  await f.pageHost.start();
  const a = harness(f.pageHost, "a", f.jars);
  a.view();
  a.open();
  await a.wait();
  const b = harness(f.pageHost, "b", f.jars);
  b.view();
  b.open(1, "POST", "/api", true);
  b.receive({ type: "web.data", stream: 1, bytes: Buffer.from("literal body") });
  b.receive({ type: "web.end", stream: 1 });
  const messages = await b.wait();
  expect(messages.some((m) => m.type === "web.head" && m.status === 200)).toBe(true);
  expect(
    Buffer.concat(
      messages
        .filter((m): m is WebMessageOf<"web.data"> => m.type === "web.data")
        .map((m) => Buffer.from(m.bytes)),
    ).toString(),
  ).toBe("literal body");
});
it("opens a fixed URL without spawning, using its path without revealing a start command", async () => {
  const f = fixture(),
    server = http.createServer((_req, res) => res.end("Dashboard"));
  servers.push(server);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as import("node:net").AddressInfo).port;
  f.register("board", { shellbell: 1, name: "Metrics", url: `http://127.0.0.1:${port}/dashboard` });
  await f.pageHost.start();
  const h = harness(f.pageHost, "phone", f.jars);
  h.view();
  h.open();
  const messages = await h.wait();
  expect(messages.find((m) => m.type === "web.head")).toMatchObject({ status: 302 });
  expect(JSON.stringify(f.pageHost.entries)).not.toContain("start");
  h.open(2, "GET", "/dashboard");
  expect((await h.wait(2)).some((m) => m.type === "web.head" && m.status === 200)).toBe(true);
});
it("stops the owned process group after the last viewer leaves and starts a new instance next time", async () => {
  const f = fixture({ idleMs: 35, killMs: 30 });
  f.register("board", {
    shellbell: 1,
    name: "Board",
    start: [process.execPath, f.script(serverScript)],
    cwd: f.home,
  });
  await f.pageHost.start();
  f.pageHost.view("board", "one", true);
  f.pageHost.view("board", "two", true);
  const first = await f.pageHost.resolve("board", "one", "one", new AbortController().signal);
  f.pageHost.leave("one");
  expect(f.pageHost.current(first)).toBe(true);
  f.pageHost.leave("two");
  await vi.waitFor(() => expect(f.pageHost.current(first)).toBe(false));
  f.pageHost.view("board", "one", true);
  const second = await f.pageHost.resolve("board", "one", "one", new AbortController().signal);
  expect(second.key).not.toBe(first.key);
  expect(readFileSync(join(f.home, "starts.txt"), "utf8").trim().split("\n")).toHaveLength(2);
});
it("retires an unsafe or replaced registration and closes its active route work", async () => {
  const f = fixture();
  f.register("board", {
    shellbell: 1,
    name: "Board",
    start: [process.execPath, f.script(serverScript)],
    cwd: f.home,
  });
  await f.pageHost.start();
  f.pageHost.view("board", "viewer", true);
  const first = await f.pageHost.resolve("board", "viewer", "phone", new AbortController().signal);
  chmodSync(join(f.directory, "board.json"), 0o664);
  await f.pageHost.registry.refresh();
  expect(f.pageHost.current(first)).toBe(false);
  expect(f.pageHost.entries[0]?.skipped).toBeDefined();
});
it("returns bounded startup errors and redacts addresses from diagnostics", async () => {
  const f = fixture({ startMs: 1500, killMs: 30 });
  const program = f.script(
    `console.error('failed at https://localhost:7428/?t=entry-secret');process.exitCode=1;`,
  );
  f.register("board", {
    shellbell: 1,
    name: "Board",
    start: [process.execPath, program],
    cwd: f.home,
  });
  await f.pageHost.start();
  const h = harness(f.pageHost, "phone", f.jars);
  h.view();
  h.open();
  const messages = await h.wait();
  expect(messages.find((m) => m.type === "web.reset")).toMatchObject({
    reason: "start-failed",
    detail: "failed at [address]",
  });
  expect(JSON.stringify(messages)).not.toContain("entry-secret");
  expect(
    pageFailureDetail(`oops http://localhost:7428/?t=secret ${"x".repeat(1000)}`)!.length,
  ).toBeLessThanOrEqual(120);
});
it("times out a silent program and never starts an unregistered id", async () => {
  const f = fixture({ startMs: 60, killMs: 30 });
  f.register("board", {
    shellbell: 1,
    name: "Board",
    start: [process.execPath, f.script(`setInterval(()=>{},1000)`)],
    cwd: f.home,
  });
  await f.pageHost.start();
  const h = harness(f.pageHost, "phone", f.jars);
  h.view();
  h.open();
  expect((await h.wait()).find((m) => m.type === "web.reset")).toMatchObject({
    reason: "start-timeout",
  });
  h.receive({
    type: "web.open",
    stream: 2,
    target: { page: "missing" },
    method: "GET",
    path: "/",
    headers: [],
    body: false,
    upgrade: false,
  });
  expect((await h.wait(2)).some((m) => m.type === "web.reset")).toBe(true);
});
it("aborts a pending start when the phone's view closes and fences late replies", async () => {
  const f = fixture({ startMs: 200, killMs: 30 });
  f.register("board", {
    shellbell: 1,
    name: "Board",
    start: [
      process.execPath,
      f.script(`setTimeout(()=>console.log('http://localhost:12345/'),100)`),
    ],
    cwd: f.home,
  });
  await f.pageHost.start();
  const h = harness(f.pageHost, "phone", f.jars);
  h.view();
  h.open();
  h.view("board", false);
  await h.wait();
  expect(h.sent.some((m) => m.type === "web.head")).toBe(false);
});

const expiringServer = `const http=require('node:http');let logins=0,valid=false,actions=0;const server=http.createServer((req,res)=>{if(req.url==='/?t=entry-secret'){logins++;valid=true;res.writeHead(302,{'Set-Cookie':'login='+logins+'; Path=/','Location':'/'});res.end();return;}if(req.url==='/expire'){valid=false;res.end();return;}if(req.url==='/stats'){res.end(JSON.stringify({logins,actions}));return;}if(req.method==='POST'){actions++;req.resume();}if(!valid||!req.headers.cookie?.includes('login='+logins)||req.url==='/always-forbidden'){res.writeHead(403);res.end('expired');return;}res.end(req.headers['x-preserved']||'Ready');});server.listen(0,'127.0.0.1',()=>console.log(JSON.stringify({url:'http://127.0.0.1:'+server.address().port+'/?t=entry-secret'})));`;
function body(messages: WebMessage[]): string {
  return Buffer.concat(
    messages
      .filter((m): m is WebMessageOf<"web.data"> => m.type === "web.data")
      .map((m) => Buffer.from(m.bytes)),
  ).toString();
}
it("refreshes an expired sign-in once and preserves a retried GET's headers", async () => {
  const f = fixture();
  f.register("board", {
    shellbell: 1,
    name: "Board",
    start: [process.execPath, f.script(expiringServer)],
    cwd: f.home,
  });
  await f.pageHost.start();
  const h = harness(f.pageHost, "phone", f.jars);
  h.view();
  h.open();
  await h.wait();
  h.open(2, "GET", "/expire");
  await h.wait(2);
  h.open(3, "GET", "/check", false, [["x-preserved", Buffer.from("still here")]]);
  expect(body(await h.wait(3))).toBe("still here");
  h.open(4, "GET", "/always-forbidden");
  expect((await h.wait(4)).find((m) => m.type === "web.head")).toMatchObject({ status: 403 });
  h.open(5, "GET", "/stats");
  expect(JSON.parse(body(await h.wait(5)))).toEqual({ logins: 2, actions: 0 });
  expect(JSON.stringify(h.sent)).not.toContain("entry-secret");
});
it("refreshes sign-in after a rejected POST but never replays its body or action", async () => {
  const f = fixture();
  f.register("board", {
    shellbell: 1,
    name: "Board",
    start: [process.execPath, f.script(expiringServer)],
    cwd: f.home,
  });
  await f.pageHost.start();
  const h = harness(f.pageHost, "phone", f.jars);
  h.view();
  h.open();
  await h.wait();
  h.open(2, "GET", "/expire");
  await h.wait(2);
  h.open(3, "POST", "/action", true);
  h.receive({ type: "web.data", stream: 3, bytes: Buffer.from("do it once") });
  h.receive({ type: "web.end", stream: 3 });
  expect((await h.wait(3)).find((m) => m.type === "web.head")).toMatchObject({ status: 403 });
  let stream = 3;
  await vi.waitFor(async () => {
    h.open(++stream, "GET", "/stats");
    expect(JSON.parse(body(await h.wait(stream)))).toEqual({ logins: 2, actions: 1 });
  });
});
it.each(["idle", "shutdown"] as const)("kills descendant processes on %s", async (stop) => {
  const f = fixture({ idleMs: 35, killMs: 40 });
  const code = `const cp=require('node:child_process'),fs=require('node:fs'),http=require('node:http');const p=cp.spawn(process.execPath,['-e',"process.on('SIGTERM',()=>{});setInterval(()=>{},1000)"],{stdio:'ignore'});fs.writeFileSync('pids.json',JSON.stringify([process.pid,p.pid]));const s=http.createServer((_,r)=>r.end('ready'));s.listen(0,'127.0.0.1',()=>console.log('http://127.0.0.1:'+s.address().port+'/'));`;
  f.register("board", {
    shellbell: 1,
    name: "Board",
    start: [process.execPath, f.script(code)],
    cwd: f.home,
  });
  await f.pageHost.start();
  f.pageHost.view("board", "viewer", true);
  await f.pageHost.resolve("board", "viewer", "phone", new AbortController().signal);
  const pids = JSON.parse(readFileSync(join(f.home, "pids.json"), "utf8")) as number[];
  if (stop === "idle") f.pageHost.leave("viewer");
  else await f.pageHost.close();
  await vi.waitFor(
    () => {
      for (const pid of pids) expect(() => process.kill(pid, 0)).toThrow();
    },
    { timeout: 5000 },
  );
});
