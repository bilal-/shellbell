import { describe, expect, it } from "vitest";
import { VtLog } from "../src/net/mobile-screen-stream";
import {
  TerminalBridge,
  type TerminalFrame,
  type TerminalModel,
  TerminalVtBridge,
  type TerminalVtMessage,
  VT_MESSAGE_BYTES,
} from "../src/terminal/bridge";

function model(value: string): TerminalModel {
  return {
    cols: 80,
    fontSize: 14,
    fitWidth: false,
    cursor: null,
    rows: [{ key: "live:0", history: false, line: { r: [{ t: value }] } }],
  };
}
describe("xterm bridge admission", () => {
  it("permits interaction only with the exact acknowledged native model", () => {
    const frames: TerminalFrame[] = [];
    const bridge = new TerminalBridge((frame) => frames.push(frame));
    const first = model("first");
    bridge.present(first);
    expect(bridge.isPresented(first)).toBe(false);
    bridge.ready("doc");
    expect(bridge.isPresented(first)).toBe(false);
    bridge.acknowledge("doc", 1);
    expect(bridge.isPresented(first)).toBe(true);
    const next = model("next");
    // A native render can precede its bridge effect; an old picture is not interactive.
    expect(bridge.isPresented(next)).toBe(false);
    bridge.present(next);
    expect(bridge.isPresented(first)).toBe(false);
    bridge.acknowledge("old-doc", 2);
    expect(bridge.isPresented(next)).toBe(false);
    bridge.acknowledge("doc", 2);
    expect(bridge.isPresented(next)).toBe(true);
  });
  it("waits for document readiness and coalesces output behind one acknowledged update", () => {
    const frames: TerminalFrame[] = [];
    const bridge = new TerminalBridge((frame) => frames.push(frame));
    bridge.present(model("first"));
    expect(frames).toHaveLength(0);
    bridge.ready("page-a");
    expect(frames).toHaveLength(1);
    bridge.present(model("obsolete"));
    bridge.present(model("latest"));
    expect(frames).toHaveLength(1);
    bridge.acknowledge("page-a", 1);
    expect(frames).toHaveLength(2);
    expect(frames[1]?.upsert[0]?.line.r[0]?.t).toBe("latest");
    expect(frames[1]?.order).toBeUndefined();
  });
  it("resends a full state to a reloaded document and ignores old acknowledgments", () => {
    const frames: TerminalFrame[] = [];
    const bridge = new TerminalBridge((frame) => frames.push(frame));
    bridge.present(model("first"));
    bridge.ready("old");
    bridge.present(model("latest"));
    bridge.ready("new");
    expect(frames[1]?.order).toEqual(["live:0"]);
    expect(frames[1]?.upsert[0]?.line.r[0]?.t).toBe("latest");
    bridge.present(model("next"));
    bridge.acknowledge("old", 1);
    bridge.acknowledge("new", 99);
    expect(frames).toHaveLength(2);
    bridge.acknowledge("new", 1);
    expect(frames).toHaveLength(3);
  });
  it("does not resend unchanged history with each live update", () => {
    const frames: TerminalFrame[] = [];
    const bridge = new TerminalBridge((frame) => frames.push(frame));
    const history = { key: "history:0", history: true, line: { r: [{ t: "old" }] } };
    const first = model("first");
    first.rows = [history, ...first.rows];
    bridge.present(first);
    bridge.ready("page");
    bridge.acknowledge("page", 1);
    const next = model("next");
    next.rows = [history, ...next.rows];
    bridge.present(next);
    expect(frames[1]?.upsert.map((row) => row.key)).toEqual(["live:0"]);
    expect(frames[1]?.order).toBeUndefined();
  });
});

describe("raw terminal bridge", () => {
  const bytes = (text: string) => new TextEncoder().encode(text);
  const decode = (message: TerminalVtMessage) => Buffer.from(message.data, "base64").toString();

  it("sends the starting point, then each chunk, one at a time and in order", () => {
    const sent: TerminalVtMessage[] = [];
    const vt = new TerminalVtBridge((message) => sent.push(message));
    const log = new VtLog(1, 90, 20, bytes("seed"));
    log.append(bytes("a"));
    vt.present(log);
    expect(sent).toEqual([]);
    vt.ready("doc");
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ document: "doc", sequence: 1, reset: { cols: 90, rows: 20 } });
    expect(decode(sent[0]!)).toBe("seed");
    log.append(bytes("bé"));
    vt.present(log);
    expect(sent).toHaveLength(1);
    vt.acknowledge("doc", 1);
    vt.acknowledge("doc", 2);
    expect(sent.map(decode)).toEqual(["seed", "a", "bé"]);
    expect(sent[2]).not.toHaveProperty("reset");
    vt.acknowledge("other", 3);
    log.append(bytes("c"));
    vt.present(log);
    expect(sent).toHaveLength(3);
  });

  it("starts a new subscription's log from its seed even when its generation repeats", () => {
    const sent: TerminalVtMessage[] = [];
    const vt = new TerminalVtBridge((message) => sent.push(message));
    vt.ready("doc");
    const first = new VtLog(1, 80, 24, bytes("seed A"));
    first.append(bytes("a1"));
    vt.present(first);
    vt.acknowledge("doc", 1);
    vt.acknowledge("doc", 2);
    // Resubscribed: the computer's new source counts generations from 1 again.
    const second = new VtLog(1, 80, 24, bytes("seed B"));
    vt.present(second);
    expect(sent.map(decode)).toEqual(["seed A", "a1", "seed B"]);
    expect(sent[2]).toMatchObject({ reset: { cols: 80, rows: 24 } });
  });

  it("replays a new generation or a reloaded document from its starting point", () => {
    const sent: TerminalVtMessage[] = [];
    const vt = new TerminalVtBridge((message) => sent.push(message));
    vt.ready("doc");
    vt.present(new VtLog(1, 80, 24, bytes("one")));
    vt.acknowledge("doc", 1);
    vt.present(new VtLog(2, 80, 24, bytes("two")));
    expect(sent.map(decode)).toEqual(["one", "two"]);
    expect(sent[1]?.reset).toEqual({ cols: 80, rows: 24 });
    vt.ready("reloaded");
    expect(sent.at(-1)).toMatchObject({ document: "reloaded", sequence: 1 });
    expect(decode(sent.at(-1)!)).toBe("two");
  });

  it("splits a large starting point so no message exceeds the bridge limit", () => {
    const sent: TerminalVtMessage[] = [];
    const vt = new TerminalVtBridge((message) => sent.push(message));
    vt.ready("doc");
    const seed = new Uint8Array(VT_MESSAGE_BYTES * 2 + 5).map((_, i) => i % 251);
    vt.present(new VtLog(1, 80, 24, seed));
    for (let i = 1; i <= 3; i++) vt.acknowledge("doc", i);
    expect(sent).toHaveLength(3);
    expect(sent.map((m) => Boolean(m.reset))).toEqual([true, false, false]);
    const joined = Buffer.concat(sent.map((m) => Buffer.from(m.data, "base64")));
    expect(joined.equals(Buffer.from(seed))).toBe(true);
  });
});
