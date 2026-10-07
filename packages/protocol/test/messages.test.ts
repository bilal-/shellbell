import { describe, expect, it } from "vitest";
import { parseCtrl } from "../src/ctrl.js";
import { parseInner } from "../src/inner.js";
import { parseInnerLoose } from "../src/loose.js";
import { parseInner as parseLegacyInner } from "./fixtures/legacy-protocol-20260921/inner.js";
import { parseInnerLoose as parseLegacyLoose } from "./fixtures/legacy-protocol-20260921/loose.js";

describe("encrypted hello host platform", () => {
  const hello = {
    type: "hello",
    agentVersion: "0.0.1",
    backends: [],
    computerName: "host",
    accent: "#0f0",
  };
  it("keeps legacy hello valid without claiming a platform", () => {
    expect(parseInner(hello)).toEqual(hello);
    expect(parseInnerLoose(hello)).toEqual(hello);
  });
  it.each(["darwin", "linux", "win32", "unknown"])(
    "preserves %s without breaking an old reader",
    (hostPlatform) => {
      expect(parseInner({ ...hello, hostPlatform })).toMatchObject({ hostPlatform });
      expect(parseInnerLoose({ ...hello, hostPlatform })).toMatchObject({ hostPlatform });
      expect(parseLegacyInner({ ...hello, hostPlatform })).toEqual(hello);
      expect(parseLegacyLoose({ ...hello, hostPlatform })).toEqual(hello);
    },
  );
  it.each([null, 12, {}, "macos", "", "freebsd"])(
    "rejects malformed platform %j",
    (hostPlatform) => {
      expect(() => parseInner({ ...hello, hostPlatform })).toThrow(/malformed/);
      expect(() => parseInnerLoose({ ...hello, hostPlatform })).toThrow(/malformed/);
    },
  );
});

const FP = "c".repeat(26);
const box = { n: new Uint8Array(24), c: new Uint8Array(3) };

describe("ctrl messages", () => {
  it("parses every ctrl type", () => {
    const ok = [
      { type: "challenge", nonce: new Uint8Array(32), connId: "abc" },
      {
        type: "auth",
        role: "phone",
        fp: FP,
        ed25519Pub: new Uint8Array(32),
        sig: new Uint8Array(64),
        name: "iPhone",
        appVersion: "0.1.0",
      },
      {
        type: "auth",
        role: "pairing",
        fp: FP,
        ed25519Pub: new Uint8Array(32),
        sig: new Uint8Array(64),
        name: "iPhone",
        appVersion: "0.1.0",
        gate: new Uint8Array(16),
      },
      {
        type: "auth-ok",
        role: "phone",
        agentOnline: true,
        computerName: "MBP",
        serverTime: 1,
        minFrameMs: 125,
      },
      { type: "auth-fail", reason: "no-window" },
      { type: "presence", agentOnline: false, computerName: null },
      { type: "unpaired", phoneFps: [FP] },
      { type: "phones", connected: [{ phoneFp: FP, connId: "abc", name: "iPhone" }] },
      {
        type: "pairings-sync",
        phones: [{ phoneFp: FP, ed25519Pub: new Uint8Array(32), name: "iPhone" }],
      },
      { type: "pairing-open", gateHash: new Uint8Array(32), expiresAt: 123 },
      { type: "pairing-close" },
      { type: "pairing-request", phoneFp: FP, box },
      { type: "pairing-response", phoneFp: FP, box },
      { type: "pairing-reject", phoneFp: FP, reason: "declined" },
      { type: "pairing-add", phoneFp: FP, ed25519Pub: new Uint8Array(32), name: "iPhone" },
      { type: "unpair", phoneFp: FP },
      { type: "push-token", token: "ExponentPushToken[x]", platform: "ios", enabled: true },
      { type: "lease", ttlMs: 60000 },
      { type: "notify", sessionId: "iterm2:1", kind: "prompt", exitCode: 0, durationMs: 12000 },
      { type: "notify", sessionId: "herdr:term_a", kind: "blocked" },
      { type: "phone-connected", phoneFp: FP, connId: "abc", name: "iPhone" },
      { type: "phone-disconnected", phoneFp: FP, connId: "abc" },
      { type: "error", code: "x", message: "y" },
    ];
    for (const m of ok) expect(parseCtrl(m).type).toBe(m.type);
  });
  it("rejects unknown type, bad role, oversized lists", () => {
    expect(() => parseCtrl({ type: "nope" })).toThrow(/malformed/);
    expect(() => parseCtrl({ type: "auth", role: "god", fp: FP })).toThrow(/malformed/);
    expect(() => parseCtrl({ type: "lease", ttlMs: 999999 })).toThrow(/malformed/);
    expect(() =>
      parseCtrl({
        type: "pairings-sync",
        phones: Array(11).fill({ phoneFp: FP, ed25519Pub: new Uint8Array(32), name: "x" }),
      }),
    ).toThrow(/malformed/);
  });
});

describe("inner messages", () => {
  it("parses representative inner types", () => {
    const line = {
      r: [
        { t: "hi", fg: 2, b: true },
        { t: "漢", n: 2 },
      ],
    };
    const caps = {
      subscribe: true,
      prompts: true,
      createSession: true,
      focus: true,
      history: true,
      absoluteLines: true,
    };
    const ok = [
      { type: "conn.hello", n: new Uint8Array(16) },
      {
        type: "hello",
        agentVersion: "0.1.0",
        backends: [{ name: "iterm2", capabilities: caps }],
        computerName: "MBP",
        accent: "emerald",
      },
      {
        type: "sessions",
        list: [
          {
            id: "iterm2:x",
            backend: "iterm2",
            title: "zsh",
            cols: 80,
            rows: 24,
            windowId: "iterm2:w1",
            windowNumber: 1,
            tabId: "iterm2:t1",
            tabIndex: 0,
            paneIndex: 0,
            isFocusedOnMac: true,
            state: "editing",
          },
        ],
      },
      {
        type: "screen.snapshot",
        sessionId: "iterm2:x",
        cols: 80,
        rows: 1,
        cursor: { x: 0, y: 0 },
        lines: [line],
        scrollbackTotal: 0,
        gen: 1,
        reset: true,
        degraded: false,
      },
      {
        type: "screen.diff",
        sessionId: "iterm2:x",
        scroll: 1,
        changed: [{ i: 0, line }],
        cursor: { x: 0, y: 0 },
        scrollbackTotal: 1,
        gen: 2,
      },
      { type: "history", sessionId: "iterm2:x", before: 10, lines: [line], oldestAvailable: 0 },
      { type: "event", sessionId: "iterm2:x", kind: "idle", durationMs: 5000, at: 1 },
      { type: "event", sessionId: "herdr:term_a", kind: "blocked", at: 1 },
      {
        type: "sessions",
        list: [
          {
            id: "herdr:term_a",
            backend: "herdr",
            title: "Claude Code",
            cols: 80,
            rows: 24,
            windowId: "herdr:w1",
            windowNumber: 1,
            tabId: "herdr:w1:t1",
            tabIndex: 0,
            paneIndex: 0,
            isFocusedOnMac: false,
            state: "blocked",
          },
        ],
      },
      { type: "session.create", reqId: "r10", in: { kind: "tab", backend: "herdr" } },
      { type: "ack", reqId: "r1", ok: true, sessionId: "iterm2:y" },
      { type: "subscribe", sessionId: "iterm2:x" },
      { type: "subscribe", sessionId: null },
      { type: "input.line", reqId: "r2", sessionId: "iterm2:x", text: "ls" },
      { type: "input.text", reqId: "r3", sessionId: "iterm2:x", text: "a" },
      { type: "input.key", reqId: "r4", sessionId: "iterm2:x", key: "ctrl-c" },
      { type: "history.get", reqId: "r5", sessionId: "iterm2:x", before: 10, count: 200 },
      { type: "session.create", reqId: "r6", in: { kind: "tab", backend: "tmux" } },
      {
        type: "session.create",
        reqId: "r7",
        in: { kind: "split", sessionId: "iterm2:x", direction: "vertical" },
      },
      { type: "session.focus", reqId: "r8", sessionId: "iterm2:x" },
      { type: "snapshot.get", reqId: "r9", sessionId: "iterm2:x" },
    ];
    for (const m of ok) expect(parseInner(m).type).toBe(m.type);
  });
  it("rejects a bad key name, count out of range, missing reqId, removed types", () => {
    expect(() =>
      parseInner({ type: "input.key", reqId: "r", sessionId: "x", key: "ctrl-alt-del" }),
    ).toThrow(/malformed/);
    expect(() =>
      parseInner({ type: "history.get", reqId: "r", sessionId: "x", before: 1, count: 201 }),
    ).toThrow(/malformed/);
    expect(() => parseInner({ type: "input.line", sessionId: "x", text: "ls" })).toThrow(
      /malformed/,
    );
    expect(() =>
      parseInner({ type: "session.rename", reqId: "r", sessionId: "x", title: "t" }),
    ).toThrow(/malformed/);
    expect(() => parseInner({ type: "event", sessionId: "x", kind: "bell", at: 1 })).toThrow(
      /malformed/,
    );
    expect(() =>
      parseInner({
        type: "session.create",
        reqId: "r",
        in: { kind: "tab", backend: "bad/backend" },
      }),
    ).toThrow(/malformed/);
  });
});
