import { describe, expect, it } from "vitest";
import { TerminalBridge, type TerminalFrame, type TerminalModel } from "../src/terminal/bridge";

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
