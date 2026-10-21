import {
  CONTINUATION_EXTENSIONS,
  type StreamMessage,
  StreamSender,
  type StreamTransferMeta,
} from "@shellbell/protocol";
import { SerializeAddon } from "@xterm/addon-serialize";
import { UnicodeGraphemesAddon } from "@xterm/addon-unicode-graphemes";
import { Terminal } from "@xterm/headless";
import { afterEach, describe, expect, it } from "vitest";
import { MobileScreenStream, VtLog } from "../src/net/mobile-screen-stream";
import { RetainedTerminal } from "../src/net/retained-terminal";
import { TerminalVtBridge } from "../src/terminal/vt-bridge";
import { writeVt } from "../src/terminal/vt-checkpoint";
import { VtRenderer } from "../src/terminal/vt-renderer";
import { VtReplayLog, type VtSeed } from "../src/terminal/vt-replay-log";
import {
  decodeVtBytes,
  encodeVtBytes,
  type TerminalVtMessage,
  VT_MESSAGE_BYTES,
  type VtRendererEvent,
} from "../src/terminal/vt-wire";

const bytes = (text: string) => new TextEncoder().encode(text);
const terminals: Terminal[] = [];
afterEach(() => {
  for (const term of terminals.splice(0)) term.dispose();
});
const lines = (term: Terminal) =>
  Array.from({ length: term.buffer.normal.length }, (_, i) =>
    term.buffer.normal.getLine(i)!.translateToString(true),
  );
function source(seed: string | Uint8Array, patch: Partial<VtSeed> = {}) {
  return new VtReplayLog(
    {
      kind: "vt-seed",
      generation: 1,
      cols: 40,
      rows: 4,
      capture: "aaaaaaaaaaaaaaaaaaaaaa",
      disposition: "initial",
      reason: "start",
      cursor: "real",
      alternate: "real",
      ...patch,
    },
    typeof seed === "string" ? bytes(seed) : seed,
  );
}
function harness() {
  const sent: TerminalVtMessage[] = [];
  const queue: TerminalVtMessage[] = [];
  const events: VtRendererEvent[] = [];
  const failures: string[] = [];
  let automatic = true;
  const bridge = new TerminalVtBridge(
    (message) => {
      sent.push(message);
      queue.push(message);
    },
    (_source, reason) => failures.push(reason),
  );
  let term: Terminal;
  let renderer: VtRenderer;
  const deliver = (event: VtRendererEvent) => {
    if (bridge.receiveHistory(event)) return;
    if (event.type === "vt-ack") bridge.acknowledge(event.document, event.sequence, event.epoch);
    else if (event.type === "vt-error")
      bridge.reject(event.document, event.sequence, event.epoch, event.reason);
  };
  function reload(document: string) {
    queue.length = 0;
    term = new Terminal({ cols: 80, rows: 24, scrollback: 10000, allowProposedApi: true });
    terminals.push(term);
    const serializer = new SerializeAddon();
    term.loadAddon(new UnicodeGraphemesAddon() as unknown as Parameters<Terminal["loadAddon"]>[0]);
    term.loadAddon(serializer as unknown as Parameters<Terminal["loadAddon"]>[0]);
    renderer = new VtRenderer(term, serializer, document, (event) => {
      events.push(event);
      if (automatic) deliver(event);
    });
    bridge.ready(document);
  }
  reload("doc-a");
  return {
    bridge,
    sent,
    queue,
    events,
    failures,
    deliver,
    reload,
    get term() {
      return term;
    },
    get renderer() {
      return renderer;
    },
    set automatic(value: boolean) {
      automatic = value;
    },
    async step() {
      const message = queue.shift();
      if (!message) throw new Error("No queued operation");
      await renderer.receive(message);
      return message;
    },
    async drain() {
      let count = 0;
      while (queue.length) {
        if (++count > 100) throw new Error("Bridge did not settle");
        await this.step();
      }
    },
  };
}

describe("negotiated native/WebView bridge", () => {
  it("requests a fresh checkpoint after two explicit failures restoring the same log", async () => {
    const log = source("saved screen");
    log.apply(0);
    const h = harness();
    h.bridge.present(log);
    const first = h.queue.shift()!;
    h.bridge.reject(first.document, first.sequence, first.epoch, "renderer");
    expect(h.failures).toEqual(["renderer"]);
    h.reload("retry-document");
    const second = h.queue.shift()!;
    h.bridge.reject(second.document, second.sequence, second.epoch, "renderer");
    expect(h.failures).toEqual(["renderer", "checkpoint-missing"]);
    log.dispose();
  });

  it("starts fresh render progress when a new bridge mounts an already applied log", async () => {
    const log = source("old screen");
    log.append(0, bytes(" tail"));
    log.apply(5);
    log.didReport(5);
    const h = harness();
    h.bridge.present(log);
    expect(log.renderedOffset).toBe(-1);
    expect(log.isRestoring).toBe(true);
    expect(log.appliedOffset).toBe(5);
    await h.drain();
    expect(log.isRestoring).toBe(false);
    expect(log.renderedOffset).toBe(5);
    expect(log.pendingApplied).toBeNull();
    expect(lines(h.term).some((line) => line.includes("old screen tail"))).toBe(true);
    log.dispose();
  });

  it("restores current rendering and carries native history through a negotiated reconnect", async () => {
    const h = harness();
    const terminal = new RetainedTerminal("computer-a", "tmux:a");
    let now = 0;
    const connect = (subscriptionId: string) => {
      const controls: StreamMessage[] = [];
      const chunks: StreamMessage[] = [];
      let serial = 0;
      const mobile = new MobileScreenStream({
        subscriptionId,
        sessionId: "tmux:a",
        vt: true,
        terminal,
        now: () => now,
        sendControl: (m) => {
          controls.push(m);
          return true;
        },
      });
      const sender = new StreamSender({
        subscriptionId,
        sessionId: "tmux:a",
        now: () => now,
        newTransferId: () => String(++serial).padStart(22, "T"),
        send: (m) => {
          chunks.push(m);
          return true;
        },
      });
      mobile.start();
      mobile.receive(
        { type: "stream.accepted", subscriptionId, extensions: [...CONTINUATION_EXTENSIONS] },
        200,
      );
      return {
        mobile,
        controls,
        offer(meta: StreamTransferMeta, text: string) {
          expect(sender.offer(meta, bytes(text)).accepted).toBe(true);
          sender.pump();
          while (chunks.length) mobile.receive(chunks.shift()!, 200);
          const receipt = controls.filter((m) => m.type === "stream.ack").at(-1);
          if (receipt?.type === "stream.ack") sender.acknowledge(subscriptionId, receipt.through);
          h.bridge.present(mobile.snapshot.vt!.log);
        },
      };
    };
    const first = connect("S".repeat(22));
    first.offer(source("").meta, Array.from({ length: 40 }, (_, i) => `saved-${i}`).join("\r\n"));
    expect(first.controls.some((m) => m.type === "stream.ack")).toBe(true);
    expect(first.controls.some((m) => m.type === "stream.applied")).toBe(false);
    await h.drain();
    first.offer({ kind: "vt", generation: 1, offset: 0 }, "\r\ntail row\r\n");
    await h.drain();
    const old = terminal.log!;
    now = 50;
    first.mobile.tick();
    expect(old.pendingApplied).toBeNull();
    h.reload("doc-b");
    expect(old.renderedOffset).toBe(-1);
    expect(first.mobile.snapshot.output?.state).toBe("catching-up");
    await h.drain();
    expect(old.renderedOffset).toBe(old.receivedOffset);
    expect(first.mobile.snapshot.output?.state).toBe("live");
    expect(lines(h.term)).toContain("tail row");

    first.mobile.cancel(true);
    const next = connect("N".repeat(22));
    expect(next.controls[0]).toMatchObject({ retained: true });
    next.offer(
      source("", { disposition: "discontinuity", reason: "start", capture: "b".repeat(22) }).meta,
      "new live screen",
    );
    expect(old.isDisposed).toBe(true);
    await h.drain();
    expect(h.failures).toEqual([]);
    expect(terminal.log!.history!.rows).toBeGreaterThan(0);
    expect(lines(h.term)).toContain("saved-0");
    expect(lines(h.term).some((line) => line.includes("new live screen"))).toBe(true);
    expect(next.mobile.snapshot.output?.state).toBe("live");
    terminal.end();
  });

  it("never captures a different focused computer or session into a new owner", async () => {
    const h = harness();
    const first = new RetainedTerminal("computer-a", "tmux:a");
    first.bind("S".repeat(22), () => {});
    h.bridge.present(first.install("S".repeat(22), source("").meta, bytes("private old session")));
    await h.drain();
    const next = new RetainedTerminal("computer-b", "tmux:a");
    next.bind("N".repeat(22), () => {});
    const log = next.install(
      "N".repeat(22),
      source("", { disposition: "discontinuity", reason: "start" }).meta,
      bytes("new session"),
    )!;
    h.bridge.present(log);
    await h.drain();
    expect(h.failures).toEqual(["checkpoint-missing"]);
    expect(log.history).toBeNull();
    expect(log.appliedOffset).toBe(-1);
    first.end();
    next.end();
  });

  it.each([40, 20, 80])(
    "keeps a scrolled-up reader on the same retained row at %i columns",
    async (cols) => {
      const h = harness();
      const first = source(
        Array.from({ length: 200 }, (_, i) =>
          i === 30 ? "anchor row" : `row-${i}-${"x".repeat(50)}`,
        ).join("\r\n"),
      );
      h.bridge.present(first);
      await h.drain();
      h.term.scrollToLine(lines(h.term).indexOf("anchor row"));
      expect(
        h.term.buffer.active.getLine(h.term.buffer.active.viewportY)!.translateToString(true),
      ).toBe("anchor row");
      first.dispose();
      const next = source("new screen", {
        generation: 2,
        disposition: "discontinuity",
        reason: "resize",
        cols,
        rows: 6,
      });
      h.bridge.present(next);
      await h.drain();
      expect(h.term.buffer.active.viewportY).toBeLessThan(h.term.buffer.active.baseY);
      expect(
        h.term.buffer.active.getLine(h.term.buffer.active.viewportY)!.translateToString(true),
      ).toBe("anchor row");
      expect(h.failures).toEqual([]);
    },
  );

  it("keeps one scroll through discontinuity seeds and restores it on a new document", async () => {
    const h = harness();
    const first = source("old0\r\nold1\r\nscreen0\r\nscreen1\r\nscreen2\r\nscreen3");
    h.bridge.present(first);
    await h.drain();
    expect(first.appliedOffset).toBe(0);
    first.dispose();
    const next = source("new screen", {
      generation: 2,
      disposition: "discontinuity",
      reason: "resize",
      cols: 20,
      rows: 3,
    });
    h.bridge.present(next);
    const capture = await h.step();
    expect(capture.checkpoint?.kind).toBe("capture");
    expect(next.history?.rows).toBe(3);
    expect(next.appliedOffset).toBe(-1);
    expect(next.pendingApplied).toBeNull();
    await h.drain();
    expect(lines(h.term)).toEqual(["old0", "old1", "[History may have a ", "new screen", "", ""]);
    const before = lines(h.term);
    expect(next.didReport(0)).toBe(true);
    h.reload("doc-b");
    await h.drain();
    expect(lines(h.term)).toEqual(before);
    expect(next.pendingApplied).toBeNull();
    expect(h.failures).toEqual([]);
    // Another reconnect gets one new divider, not another copy of old seed history.
    next.dispose();
    const again = source("connected", {
      disposition: "discontinuity",
      reason: "reconnect",
      cols: 20,
      rows: 3,
    });
    h.bridge.present(again);
    await h.drain();
    expect(lines(h.term).filter((line) => line === "old0")).toHaveLength(1);
    expect(lines(h.term).filter((line) => line.startsWith("[History"))).toHaveLength(2);
  });

  it("advances application only after the full seed and parser ACK, including split seeds", async () => {
    const h = harness();
    h.automatic = false;
    const log = source(`${"\x1b[0m".repeat(70000)}prompt`);
    h.bridge.present(log);
    await h.step(); // restore header
    expect(log.pendingApplied).toBeNull();
    h.deliver(h.events.at(-1)!);
    const part1 = await h.step();
    expect(part1.checkpoint).toEqual({ kind: "seed", complete: false });
    expect(log.appliedOffset).toBe(-1);
    h.deliver(h.events.at(-1)!);
    const part2 = await h.step();
    expect(part2.checkpoint).toEqual({ kind: "seed", complete: true });
    expect(log.appliedOffset).toBe(-1);
    h.deliver(h.events.at(-1)!);
    expect(log.pendingApplied?.offset).toBe(0);
    expect(lines(h.term)[0]).toBe("prompt");
  });

  it("restores a partial UTF-8 tail and never reports a backwards replay offset", async () => {
    const h = harness();
    const log = source("prefix ");
    h.bridge.present(log);
    await h.drain();
    expect(log.append(0, new Uint8Array([0xf0, 0x9f]))).toBe("ok");
    h.bridge.present(log);
    await h.drain();
    expect(log.didReport(2)).toBe(true);
    const original = h.term;
    h.reload("doc-b");
    await h.drain();
    expect(log.pendingApplied).toBeNull();
    const rest = new Uint8Array([0x98, 0x80]);
    expect(log.append(2, rest)).toBe("ok");
    h.bridge.present(log);
    await h.drain();
    await writeVt(original, rest);
    expect(lines(h.term)).toEqual(lines(original));
    expect(lines(h.term)[0]).toBe("prefix 😀");
    expect(log.pendingApplied?.offset).toBe(4);
  });

  it("waits for an old write before capturing and ignores its progress for the new source", async () => {
    const h = harness();
    const old = source("old\r\n1\r\n2\r\n3\r\n4");
    h.bridge.present(old);
    await h.drain();
    old.append(0, bytes("late"));
    h.bridge.present(old);
    const pending = h.queue[0]!;
    old.dispose();
    const next = source("new", { generation: 2, disposition: "discontinuity", reason: "refresh" });
    h.bridge.present(next);
    expect(h.queue).toEqual([pending]);
    await h.step();
    expect(next.appliedOffset).toBe(-1);
    expect(h.queue[0]!.checkpoint?.kind).toBe("capture");
    await h.drain();
    expect(next.appliedOffset).toBe(0);
    expect(lines(h.term)[0]).toBe("old");
    expect(h.failures).toEqual([]);
  });

  it("refuses to capture a document whose previous seed was only partly restored", async () => {
    const h = harness();
    const first = source("first");
    h.bridge.present(first);
    first.dispose();
    const next = source("next", { disposition: "discontinuity", reason: "resize" });
    h.bridge.present(next);
    await h.drain();
    expect(h.failures).toEqual(["checkpoint-missing"]);
    expect(next.history).toBeNull();
    expect(next.pendingApplied).toBeNull();
  });

  it("requires a fresh full seed after reload interrupts native history commitment", async () => {
    const h = harness();
    const first = source("old\r\n1\r\n2\r\n3\r\n4");
    h.bridge.present(first);
    await h.drain();
    first.dispose();
    const next = source("new", { generation: 2, disposition: "discontinuity", reason: "refresh" });
    h.bridge.present(next);
    h.automatic = false;
    const at = h.events.length;
    await h.step();
    const oldEvents = h.events.slice(at);
    for (const event of oldEvents.filter(
      (e) => e.type === "vt-history-start" || e.type === "vt-history-part",
    ))
      h.deliver(event);
    expect(next.history).toBeNull();
    h.reload("doc-b");
    expect(h.failures).toEqual(["checkpoint-missing"]);
    for (const event of oldEvents) h.deliver(event);
    expect(next.history).toBeNull();
    expect(next.hasRetained).toBe(false);
    next.dispose();
    h.automatic = true;
    const recovery = source("fresh history\r\n1\r\n2\r\n3\r\n4");
    h.bridge.present(recovery);
    await h.drain();
    expect(lines(h.term)[0]).toBe("fresh history");
    expect(recovery.appliedOffset).toBe(0);
  });

  it("fences late ACKs even when document and sequence are reused after a mode change", async () => {
    const h = harness();
    const log = source("seed");
    h.bridge.present(log);
    const obsolete = h.queue[0]!;
    h.reload("doc-a");
    const current = h.queue[0]!;
    expect(current.sequence).toBe(obsolete.sequence);
    expect(current.epoch).not.toBe(obsolete.epoch);
    h.bridge.acknowledge(obsolete.document, obsolete.sequence, obsolete.epoch);
    expect(h.queue).toEqual([current]);
    expect(h.bridge.acceptsStatus(obsolete.document, obsolete.epoch)).toBe(false);
    await h.drain();
    expect(log.appliedOffset).toBe(0);
  });

  it("times out only the matching render operation and rejects its late progress", async () => {
    const h = harness();
    const log = source("seed");
    h.bridge.present(log);
    const obsolete = h.bridge.pendingOperation!;
    h.reload("doc-b");
    h.bridge.timeout(obsolete);
    expect(h.failures).toEqual([]);
    await h.step(); // restore acknowledged, seed now pending
    const pending = h.bridge.pendingOperation!;
    h.bridge.timeout(pending);
    expect(h.failures).toEqual(["renderer"]);
    const replacement = source("fresh seed", { generation: 2 });
    log.dispose();
    h.bridge.present(replacement);
    // No new operation may race the parser which timed out in this document.
    expect(h.queue).toHaveLength(1);
    await h.step(); // the late parser ACK cannot report application after timeout
    expect(replacement.appliedOffset).toBe(-1);
    expect(h.bridge.pendingOperation).toBeNull();
    expect(h.queue).toHaveLength(0);
    h.reload("doc-c");
    await h.drain();
    expect(replacement.appliedOffset).toBe(0);
  });

  it("drains and cancels an old parser operation before reusing the renderer after a mode switch", async () => {
    const h = harness();
    const log = new VtLog(1, 40, 4, bytes("ready"));
    h.bridge.present(log);
    await h.drain();
    log.append(bytes("x".repeat(200000)));
    h.bridge.present(log);
    const pending = h.queue.shift()!;
    const old = h.renderer.receive(pending);
    await h.renderer.reset();
    expect(await old).toBe(false);
    expect(
      h.events.some(
        (event) =>
          event.type === "vt-ack" &&
          event.sequence === pending.sequence &&
          event.epoch === pending.epoch,
      ),
    ).toBe(false);
    await h.renderer.receive({
      document: "doc-a",
      sequence: 1,
      epoch: 99,
      reset: { cols: 40, rows: 4 },
      data: encodeVtBytes(bytes("new")),
    });
    expect(lines(h.term)[0]).toBe("new");
    expect(h.renderer.statusReady).toBe(true);
  });

  it("chunks large history both ways and never applies a partially restored checkpoint", async () => {
    const h = harness();
    const first = source(
      Array.from({ length: 9004 }, (_, i) => `${i}:abcdefghijklmnopqrstuvwxyz12345`).join("\r\n"),
    );
    h.bridge.present(first);
    await h.drain();
    first.dispose();
    const next = source("now", { generation: 2, disposition: "discontinuity", reason: "refresh" });
    h.bridge.present(next);
    await h.drain();
    const parts = h.events.filter((event) => event.type === "vt-history-part");
    expect(parts.length).toBeGreaterThan(1);
    for (const part of parts)
      if (part.type === "vt-history-part")
        expect(decodeVtBytes(part.data).length).toBeLessThanOrEqual(VT_MESSAGE_BYTES);
    const before = lines(h.term);
    next.didReport(0);
    h.reload("doc-b");
    await h.step(); // allocate history, not a parsed seed
    expect(h.renderer.statusReady).toBe(false);
    expect(next.pendingApplied).toBeNull();
    await h.step(); // first history slice
    expect(h.renderer.statusReady).toBe(false);
    await h.drain();
    expect(lines(h.term)).toEqual(before);
    expect(h.failures).toEqual([]);
  });

  it("labels Herdr idle replacement by replacing the old buffer rather than appending its history", async () => {
    const h = harness();
    const old = source("old\r\n1\r\n2\r\n3\r\n4");
    h.bridge.present(old);
    await h.drain();
    old.dispose();
    const replacement = source("idle history\r\n1\r\n2\r\n3\r\n4", {
      generation: 2,
      disposition: "replace",
      reason: "herdr-idle",
      cursor: "guessed",
      alternate: "unknown",
    });
    h.bridge.present(replacement);
    await h.drain();
    expect(lines(h.term)[0]).toBe("idle history");
    expect(lines(h.term)).not.toContain("old");
    expect(h.events.filter((event) => event.type === "vt-history-start")).toHaveLength(0);
  });

  it("retains legacy raw rendering and resets a partial parser between legacy seeds", async () => {
    const h = harness();
    h.bridge.present(new VtLog(1, 40, 4, bytes("\x1b]unfinished")));
    await h.drain();
    h.bridge.present(new VtLog(2, 40, 4, bytes("visible")));
    await h.drain();
    expect(lines(h.term)[0]).toBe("visible");
    expect(h.failures).toEqual([]);
  });
});

describe("bounded WebView byte messages", () => {
  it.each([0, 1, 2, 3, VT_MESSAGE_BYTES])("roundtrips %s bytes", (size) => {
    const data = Uint8Array.from({ length: size }, (_, i) => i % 251);
    expect(decodeVtBytes(encodeVtBytes(data))).toEqual(data);
  });
  it.each([
    "A",
    "=AAA",
    "AB==",
    "AAB=",
    "AA A",
    "____",
    "====",
    "A".repeat(Math.ceil(VT_MESSAGE_BYTES / 3) * 4),
  ])("rejects malformed or oversized base64 %#", (data) => {
    expect(() => decodeVtBytes(data)).toThrow();
  });
});
