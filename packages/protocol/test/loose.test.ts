import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  parseCtrl,
  parseCtrlLoose,
  parseInner,
  parseInnerLoose,
  runVectorChecks,
  type Vectors,
} from "../src/index.js";
import vectors from "./vectors.json" with { type: "json" };

const session = (backend: string, state: string) => ({
  id: "zsh:1",
  backend,
  title: "t",
  cols: 80,
  rows: 24,
  windowId: "w",
  windowNumber: 1,
  tabId: "t",
  tabIndex: 0,
  paneIndex: 0,
  isFocusedOnMac: false,
  state,
});

describe("loose parsing (spec 10.6)", () => {
  it("accepts an unknown backend loosely and rejects it strictly", () => {
    const msg = { type: "sessions", list: [session("zsh", "running")] };
    const loose = parseInnerLoose(msg);
    expect(loose.type).toBe("sessions");
    if (loose.type !== "sessions") throw new Error("unreachable");
    expect(loose.list[0]?.backend).toBe("zsh");
    expect(() => parseInner(msg)).toThrow(/malformed/);
  });

  it("accepts an unknown session state and an unknown event kind loosely", () => {
    const s = parseInnerLoose({ type: "sessions", list: [session("herdr", "compiling")] });
    if (s.type !== "sessions") throw new Error("unreachable");
    expect(s.list[0]?.state).toBe("compiling");
    const e = parseInnerLoose({ type: "event", sessionId: "tmux:%1", kind: "bell", at: 1 });
    if (e.type !== "event") throw new Error("unreachable");
    expect(e.kind).toBe("bell");
  });

  it("accepts an unknown backend inside hello.backends", () => {
    const caps = {
      subscribe: true,
      prompts: false,
      createSession: false,
      focus: false,
      history: false,
      absoluteLines: false,
    };
    const h = parseInnerLoose({
      type: "hello",
      agentVersion: "9",
      backends: [{ name: "kitty", capabilities: caps }],
      launchableBackends: ["kitty", "tmux"],
      computerName: "MBP",
      accent: "emerald",
    });
    if (h.type !== "hello") throw new Error("unreachable");
    expect(h.backends[0]?.name).toBe("kitty");
    expect(h.launchableBackends).toEqual(["kitty", "tmux"]);
  });

  it("still enforces every non-enum constraint", () => {
    expect(() => parseInnerLoose({ type: "sessions", list: [session("zsh", "")] })).toThrow();
    expect(() => parseInnerLoose({ type: "event", sessionId: "", kind: "bell", at: 1 })).toThrow();
    expect(() => parseInnerLoose({ type: "input.line", sessionId: "s", text: "x" })).toThrow();
    expect(() => parseInnerLoose({ type: "not-a-message" })).toThrow(/malformed/);
  });

  it("is identical to the strict parser for known values", () => {
    const msg = { type: "sessions", list: [session("tmux", "blocked")] };
    expect(parseInnerLoose(msg)).toEqual(parseInner(msg));
  });

  // M9: LOOSE_INNER re-declares hello/sessions/event's field sets by hand rather than deriving
  // them from InnerMessageSchema, so nothing guards against the two drifting apart (a field added
  // to strict `hello` would have zod silently strip it on the phone). These two close the gap the
  // "sessions" case above already covers, exercising every non-enum field on both message types.
  it("hello's non-enum fields match the strict parser for a known backend", () => {
    const caps = {
      subscribe: true,
      prompts: true,
      createSession: true,
      focus: true,
      history: true,
      absoluteLines: true,
    };
    const msg = {
      type: "hello",
      agentVersion: "9",
      backends: [{ name: "tmux", capabilities: caps }],
      launchableBackends: ["iterm2", "herdr"],
      computerName: "MBP",
      accent: "emerald",
    };
    expect(parseInnerLoose(msg)).toEqual(parseInner(msg));
  });

  it("event's non-enum fields (including the optional ones) match the strict parser", () => {
    const msg = {
      type: "event",
      sessionId: "tmux:%1",
      kind: "exit",
      exitCode: 0,
      durationMs: 1234,
      command: "npm test",
      at: 1700000000000,
    };
    expect(parseInnerLoose(msg)).toEqual(parseInner(msg));
  });

  it("loosens notify.kind only, on the ctrl side", () => {
    const n = { type: "notify", sessionId: "tmux:%1", kind: "bell" };
    expect(parseCtrlLoose(n)).toMatchObject({ kind: "bell" });
    expect(() => parseCtrl(n)).toThrow(/malformed/);
    expect(() => parseCtrlLoose({ type: "auth-fail", reason: "brand-new" })).toThrow();
  });

  it("leaves the golden vectors byte-identical and passing", () => {
    const raw = readFileSync(new URL("./vectors.json", import.meta.url));
    // Record the hash printed by the first green run; it must never change again.
    expect(createHash("sha256").update(raw).digest("hex")).toBe(
      "fb3a56b1763655b8658cf6493b35839bca829102f8cc17b315f7915029f9887a",
    );
    expect(runVectorChecks(vectors as Vectors).every((r) => r.ok)).toBe(true);
  });
});
