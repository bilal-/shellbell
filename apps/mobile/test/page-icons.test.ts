import { sha256, WEB_FEATURE, WEB_LIMITS, type WebMessageOf } from "@shellbell/protocol";
import { afterEach, expect, it, vi } from "vitest";
import { pageTileColor, registeredApps, registeredPageForURL } from "../src/web/page-catalog";
import { PageIcons } from "../src/web/page-icons";
import { WebSession } from "../src/web/web-session";

const hash = (bytes: Uint8Array) =>
  [...sha256(bytes)].map((n) => n.toString(16).padStart(2, "0")).join("");
const png = Uint8Array.from(
  Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jf1sAAAAASUVORK5CYII=",
    "base64",
  ),
);
afterEach(() => vi.useRealTimers());

it("exposes only a supported valid Apps catalog, including unavailable installed apps", () => {
  const app = { id: "example", name: "Example", skipped: { reason: "Update Example first." } };
  const hello = { features: [WEB_FEATURE], pages: [app] };
  expect(registeredApps(hello, true)).toEqual([app]);
  expect(registeredApps(hello, false)).toEqual([]);
  expect(registeredApps({ ...hello, features: [] }, true)).toEqual([]);
  expect(registeredApps({ ...hello, pages: [{ id: "not valid" }] }, true)).toEqual([]);
  expect(registeredApps(undefined, true)).toEqual([]);
});
function fixture() {
  const sent: import("@shellbell/protocol").WebMessage[] = [];
  let icons: Record<string, string> = {};
  const session = new WebSession({
    send: (m) => {
      sent.push(m);
      return true;
    },
  });
  const cache = new PageIcons({
    session: () => session,
    changed: (value) => {
      icons = value;
    },
  });
  const receive = (frame: WebMessageOf<"web.icon.data">) =>
    session.receive(frame, frame.bytes?.length ?? 100);
  return { cache, session, sent, receive, icons: () => icons };
}
it("fetches a hash once, verifies chunks and retires unused images", () => {
  const f = fixture(),
    id = hash(png);
  f.cache.sync([{ id: "board", name: "Board", icon: id }]);
  expect(f.sent).toContainEqual({ type: "web.icon", page: "board", hash: id });
  f.receive({
    type: "web.icon.data",
    page: "board",
    hash: id,
    offset: 0,
    total: png.length,
    bytes: png.subarray(0, 30),
  });
  expect(f.icons()).toEqual({});
  f.receive({
    type: "web.icon.data",
    page: "board",
    hash: id,
    offset: 30,
    total: png.length,
    bytes: png.subarray(30),
  });
  expect(f.icons()[id]).toBe(`data:image/png;base64,${Buffer.from(png).toString("base64")}`);
  f.cache.sync([{ id: "board", name: "Board", icon: id }]);
  expect(f.sent.filter((m) => m.type === "web.icon")).toHaveLength(1);
  f.cache.sync([]);
  expect(f.icons()).toEqual({});
  f.session.close();
});
it("rejects out-of-order, oversized and altered image data, retaining the letter tile", () => {
  for (const invalid of ["offset", "large", "hash"]) {
    const f = fixture(),
      id = hash(png);
    f.cache.sync([{ id: "board", name: "Board", icon: id }]);
    const bytes = invalid === "hash" ? Uint8Array.from(png, (b) => b ^ 1) : png;
    f.receive({
      type: "web.icon.data",
      page: "board",
      hash: id,
      offset: invalid === "offset" ? 1 : 0,
      total: invalid === "large" ? WEB_LIMITS.iconBytes + 1 : bytes.length,
      bytes,
    });
    expect(f.icons()).toEqual({});
    f.session.close();
  }
});
it("requests sequentially and can recover after a lost route without retaining a partial image", () => {
  const f = fixture(),
    a = hash(png),
    other = Uint8Array.from(png);
  other[other.length - 1] = other[other.length - 1]! ^ 1;
  const b = hash(other);
  f.cache.sync([
    { id: "a", name: "A", icon: a },
    { id: "b", name: "B", icon: b },
  ]);
  expect(f.sent.filter((m) => m.type === "web.icon")).toHaveLength(1);
  f.receive({ type: "web.icon.data", page: "a", hash: a });
  expect(f.sent.filter((m) => m.type === "web.icon")).toHaveLength(2);
  f.cache.pause();
  f.cache.sync([{ id: "a", name: "A", icon: a }]);
  expect(f.sent.filter((m) => m.type === "web.icon")).toHaveLength(3);
  f.session.close();
  f.cache.clear();
});
it("times out unavailable icons and never shows unverified bytes", () => {
  vi.useFakeTimers();
  const f = fixture();
  f.cache.sync([{ id: "a", name: "A", icon: hash(png) }]);
  vi.advanceTimersByTime(10001);
  expect(f.icons()).toEqual({});
  f.session.close();
});
it("matches only advertised URL registrations and assigns stable fallback colours", () => {
  const pages = [{ id: "board", name: "Board", address: "127.0.0.1:3000" }];
  expect(registeredPageForURL(pages, "http://127.0.0.1:3000/path")?.id).toBe("board");
  expect(registeredPageForURL(pages, "http://localhost:3000/path")).toBeUndefined();
  expect(
    registeredPageForURL(
      [{ ...pages[0]!, skipped: { reason: "Unavailable" } }],
      "http://127.0.0.1:3000/",
    ),
  ).toBeUndefined();
  expect(pageTileColor("board")).toBe(pageTileColor("board"));
});

it("keeps a replacement icon request made from the completed callback", () => {
  const session = new WebSession({ send: () => true });
  const next = vi.fn();
  session.icon("board", "a".repeat(64), () => {
    session.icon("board", "b".repeat(64), next);
  });
  session.receive({ type: "web.icon.data", page: "board", hash: "a".repeat(64) }, 100);
  session.receive({ type: "web.icon.data", page: "board", hash: "b".repeat(64) }, 100);
  expect(next).toHaveBeenCalledOnce();
  session.close();
});
