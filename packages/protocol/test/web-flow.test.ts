import { describe, expect, it } from "vitest";
import {
  encodeCbor,
  WEB_LIMITS,
  type WebMessage,
  type WebMessageOf,
  WebReceiver,
  WebSender,
  webCharge,
} from "../src/index.js";

function harness(
  options: Pick<ConstructorParameters<typeof WebSender>[0], "streamWindow" | "settled"> = {},
) {
  const sent: WebMessage[] = [];
  let up = true;
  const drained: number[] = [];
  const sender = new WebSender({
    send: (message) => {
      if (!up) return false;
      sent.push(message);
      return true;
    },
    drained: (stream) => drained.push(stream),
    ...options,
  });
  const charged = () => sent.reduce((sum, message) => sum + webCharge(message), 0);
  return {
    sender,
    sent,
    drained,
    charged,
    drop: () => {
      up = false;
    },
  };
}

const head = (stream: number): WebMessageOf<"web.head"> => ({
  type: "web.head",
  stream,
  status: 200,
  headers: [],
});

describe("WebSender", () => {
  it("notifies completion only after a credit-blocked final frame drains", () => {
    const settled: number[] = [];
    const { sender } = harness({ streamWindow: 2, settled: (id) => settled.push(id) });
    sender.frame(head(1));
    sender.write(1, new Uint8Array(3));
    sender.end(1);
    expect(settled).toEqual([]);
    sender.receiveCredit({ type: "web.credit", stream: 1, bytes: 2 });
    expect(settled).toEqual([1]);
    expect(sender.sending(1)).toBe(false);
  });
  it("refunds only a locally refused frame and keeps the route usable", () => {
    const sent: WebMessage[] = [],
      refused: number[] = [];
    const sender = new WebSender({
      send: (m) => {
        if (m.type === "web.data") return "refused";
        sent.push(m);
        return true;
      },
      refused: (id) => refused.push(id),
    });
    sender.frame(head(1));
    const before = sender.outstanding;
    sender.write(1, new Uint8Array(100));
    expect(sender.outstanding).toBe(before);
    expect(sender.openStreams).toBe(0);
    expect(refused).toEqual([1]);
    sender.receiveCredit({ type: "web.credit", stream: 0, bytes: before });
    sender.frame({ ...head(3), end: true });
    expect(sent.at(-1)).toMatchObject({ type: "web.head", stream: 3 });
  });
  it("never spends more than the connection window", () => {
    const { sender, sent, charged } = harness();
    sender.frame(head(1));
    sender.write(1, new Uint8Array(1_000_000));
    expect(charged()).toBeLessThanOrEqual(WEB_LIMITS.connectionWindow);
    expect(sender.outstanding).toBe(charged());
    expect(sent.every((m) => m.type !== "web.data" || m.bytes.byteLength <= 16_384)).toBe(true);
  });

  it("keeps a burst of one-byte frames within the window plus allowance", () => {
    const { sender, charged, sent } = harness();
    for (let i = 1; i <= 2000; i++) {
      sender.frame(head(i));
      sender.write(i, new Uint8Array(1));
    }
    expect(charged()).toBeLessThanOrEqual(WEB_LIMITS.connectionWindow);
    // On the wire each frame is its inner bytes plus under 256 bytes of framing.
    const wire = sent.reduce((sum, m) => sum + encodeCbor(m).byteLength + 256, 0);
    expect(wire).toBeLessThanOrEqual(WEB_LIMITS.connectionWindow);
  });

  it("resumes when credit comes back, and refuses more credit than outstanding", () => {
    const { sender, sent } = harness();
    sender.frame(head(1));
    sender.write(1, new Uint8Array(400_000));
    const before = sent.length;
    expect(
      sender.receiveCredit({ type: "web.credit", stream: 0, bytes: sender.outstanding + 1 }),
    ).toBe(false);
    expect(sender.receiveCredit({ type: "web.credit", stream: 0, bytes: 40_000 })).toBe(true);
    // The stream window (128 KB) also binds: return it so the stream may continue.
    sender.receiveCredit({ type: "web.credit", stream: 1, bytes: 100_000 });
    expect(sent.length).toBeGreaterThan(before);
  });

  it("holds a stream at its own window without blocking another stream", () => {
    const { sender, sent } = harness({ streamWindow: 20_000 });
    sender.frame(head(1));
    sender.write(1, new Uint8Array(50_000));
    sender.frame(head(3));
    sender.write(3, new Uint8Array(10));
    sender.end(3);
    const one = sent.filter((m) => m.type === "web.data" && m.stream === 1);
    expect(one.reduce((s, m) => s + (m as WebMessageOf<"web.data">).bytes.byteLength, 0)).toBe(
      20_000,
    );
    expect(sent.some((m) => m.type === "web.end" && m.stream === 3)).toBe(true);
  });

  it("sends end after the stream's queued data, and reset drops the queue", () => {
    const { sender, sent } = harness({ streamWindow: 1000 });
    sender.frame(head(1));
    sender.write(1, new Uint8Array(5000));
    sender.end(1);
    expect(sent.some((m) => m.type === "web.end")).toBe(false);
    sender.reset(1, "closed");
    expect(sent.at(-1)).toEqual({ type: "web.reset", stream: 1, reason: "closed" });
    sender.receiveCredit({ type: "web.credit", stream: 1, bytes: 10_000 });
    expect(sent.some((m) => m.type === "web.end")).toBe(false);
    expect(sender.openStreams).toBe(0);
  });

  it("asks the source to pause and tells it when to resume", () => {
    const { sender, drained } = harness({ streamWindow: 1000 });
    sender.frame(head(1));
    expect(sender.write(1, new Uint8Array(70_000))).toBe(false);
    sender.receiveCredit({ type: "web.credit", stream: 1, bytes: 60_000 });
    expect(drained).toEqual([1]);
  });

  it("stops for good when the route refuses a send", () => {
    const { sender, sent, drop } = harness();
    drop();
    sender.frame(head(1));
    expect(sender.write(1, new Uint8Array(10))).toBe(false);
    expect(sent).toEqual([]);
  });
});

describe("WebReceiver", () => {
  function receiver() {
    const credits: WebMessageOf<"web.credit">[] = [];
    const timers: Array<() => void> = [];
    const r = new WebReceiver({
      sendCredit: (m) => credits.push(m),
      timer: (callback) => {
        timers.push(callback);
        return () => timers.splice(timers.indexOf(callback), 1);
      },
    });
    return { r, credits, timers };
  }

  it("returns connection credit at 8 KB or on the timer", () => {
    const { r, credits, timers } = receiver();
    expect(r.charged(100)).toBe(true);
    expect(credits).toEqual([]);
    timers[0]?.();
    expect(credits).toEqual([{ type: "web.credit", stream: 0, bytes: 356 }]);
    r.charged(8_000);
    expect(credits.at(-1)).toEqual({ type: "web.credit", stream: 0, bytes: 8_256 });
  });

  it("detects a sender past either window", () => {
    const { r } = receiver();
    expect(r.charged(WEB_LIMITS.connectionWindow)).toBe(false);
    const fresh = receiver().r;
    expect(fresh.body(1, WEB_LIMITS.streamWindow)).toBe(true);
    expect(fresh.body(1, 1)).toBe(false);
  });

  it("returns stream credit only as the consumer takes bytes, and never for a finished stream", () => {
    const { r, credits } = receiver();
    r.body(1, 9000);
    r.consumed(1, 9000);
    expect(credits).toEqual([{ type: "web.credit", stream: 1, bytes: 9000 }]);
    r.body(2, 100);
    r.forget(2);
    r.consumed(2, 100);
    r.flush();
    expect(credits.filter((c) => c.stream === 2)).toEqual([]);
  });

  it("matches the sender's arithmetic end to end, so neither side stalls", () => {
    const { r, credits } = receiver();
    const sent: WebMessage[] = [];
    const sender = new WebSender({
      send: (m) => {
        sent.push(m);
        return true;
      },
    });
    sender.frame(head(1));
    sender.write(1, new Uint8Array(2_000_000));
    sender.end(1);
    let delivered = 0;
    let ended = false;
    for (let guard = 0; guard < 10_000 && !ended; guard++) {
      while (sent.length) {
        const m = sent.shift() as WebMessage;
        if (m.type === "web.end") {
          ended = true;
          continue;
        }
        expect(r.charged(encodeCbor(m).byteLength)).toBe(true);
        if (m.type === "web.data") {
          expect(r.body(1, m.bytes.byteLength)).toBe(true);
          delivered += m.bytes.byteLength;
          r.consumed(1, m.bytes.byteLength);
        }
      }
      r.flush();
      while (credits.length) expect(sender.receiveCredit(credits.shift()!)).toBe(true);
    }
    expect(delivered).toBe(2_000_000);
    expect(ended).toBe(true);
  });
});
