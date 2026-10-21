import {
  CONTINUATION_EXTENSIONS,
  NATIVE_HISTORY_EXTENSION,
  nativeHistoryProof,
  prepareStreamHistory,
  type StreamChunk,
  type StreamHistoryPage,
  type StreamMessage,
  StreamSender,
  type StreamTransferMeta,
  VT_CONTINUATION_PREAMBLE,
} from "@shellbell/protocol";
import { SerializeAddon } from "@xterm/addon-serialize";
import { Terminal } from "@xterm/headless";
import { afterEach, describe, expect, it } from "vitest";
import { MobileScreenStream } from "../src/net/mobile-screen-stream";
import { RetainedTerminal } from "../src/net/retained-terminal";
import { TerminalVtBridge } from "../src/terminal/vt-bridge";
import { VtRenderer } from "../src/terminal/vt-renderer";
import { VtReplayLog, type VtSeed } from "../src/terminal/vt-replay-log";
import type { TerminalVtMessage } from "../src/terminal/vt-wire";

const SUB = "S".repeat(22),
  CAP = "C".repeat(22),
  SID = "tmux:native";
const extensions = [...CONTINUATION_EXTENSIONS, NATIVE_HISTORY_EXTENSION];
const bytes = (text: string) => new TextEncoder().encode(text);
const seedText = `${VT_CONTINUATION_PREAMBLE}new4\r\nnew5\r\nlive0\r\nlive1\r\nlive2\r\nlive3`;
const terminals: Terminal[] = [];
afterEach(() => {
  for (const term of terminals.splice(0)) term.dispose();
});
const lines = (term: Terminal) =>
  Array.from({ length: term.buffer.normal.length }, (_, i) =>
    term.buffer.normal.getLine(i)!.translateToString(true),
  );
function nativeTerminal() {
  const term = new Terminal({ cols: 20, rows: 4, scrollback: 10000, allowProposedApi: true });
  const serializer = new SerializeAddon();
  term.loadAddon(serializer as unknown as Parameters<Terminal["loadAddon"]>[0]);
  terminals.push(term);
  return { term, serializer };
}
function harness(accepted = extensions, failHidden = false) {
  let now = 0,
    serial = 0,
    at = 0;
  const owner = new RetainedTerminal("computer", SID);
  const controls: StreamMessage[] = [],
    wire: StreamChunk[] = [],
    render: TerminalVtMessage[] = [];
  const mobile = new MobileScreenStream({
    subscriptionId: SUB,
    sessionId: SID,
    vt: true,
    terminal: owner,
    now: () => now,
    sendControl: (message) => {
      controls.push(message);
      return true;
    },
  });
  const sender = new StreamSender({
    subscriptionId: SUB,
    sessionId: SID,
    now: () => now,
    newTransferId: () => (++serial).toString(36).padStart(22, "0"),
    send: (chunk) => {
      wire.push(chunk);
      return true;
    },
  });
  const bridge = new TerminalVtBridge(
    (message) => render.push(message),
    (source, reason) => {
      if (source instanceof VtReplayLog) mobile.rendererError(source, reason);
    },
    (source) => {
      if (source instanceof VtReplayLog) mobile.rendererReady(source);
    },
  );
  const original = nativeTerminal();
  let shown = original.term;
  const renderer = new VtRenderer(
    original.term,
    original.serializer,
    "doc",
    (event) => {
      if (bridge.receiveHistory(event)) return;
      if (event.type === "vt-ack") bridge.acknowledge(event.document, event.sequence, event.epoch);
      else if (event.type === "vt-error")
        bridge.reject(event.document, event.sequence, event.epoch, event.reason);
    },
    undefined,
    () => {
      if (failHidden) throw new Error("Renderer allocation failed");
      const hidden = nativeTerminal();
      return {
        ...hidden,
        present: () => {
          shown = hidden.term;
        },
        discard: () => hidden.term.dispose(),
      };
    },
  );
  mobile.start();
  mobile.receive({ type: "stream.accepted", subscriptionId: SUB, extensions: accepted }, 200);
  bridge.ready("doc");
  function pump() {
    let turns = 0;
    while (wire.length || at < controls.length) {
      if (++turns > 100) throw new Error("Wire did not settle");
      if (wire.length) mobile.receive(wire.shift()!, 200);
      while (at < controls.length) {
        const control = controls[at++]!;
        if (control.type === "stream.ack") sender.acknowledge(SUB, control.through);
      }
      sender.pump();
    }
  }
  function offer(meta: StreamTransferMeta, data: Uint8Array) {
    expect(sender.offer(meta, data).accepted).toBe(true);
    sender.pump();
    pump();
  }
  function seed(patch: Partial<VtSeed> = {}, text = seedText) {
    offer(
      {
        kind: "vt-seed",
        generation: 1,
        cols: 20,
        rows: 4,
        capture: CAP,
        disposition: "initial",
        reason: "start",
        cursor: "real",
        alternate: "real",
        historyBefore: 4,
        historyRows: 2,
        historyProof: nativeHistoryProof(20, ["new4", "new5"])!,
        ...patch,
      },
      bytes(text),
    );
    bridge.present(mobile.snapshot.vt?.log ?? null);
  }
  function page(
    request: Extract<StreamMessage, { type: "stream.history.get" }>,
    from = request.before - 2,
    present = true,
  ) {
    const record: StreamHistoryPage = {
      kind: "history",
      status: "page",
      generation: request.generation!,
      requestId: request.requestId,
      before: request.before,
      from,
      to: request.before,
      oldestAvailable: 0,
      nextBefore: from,
      lines: Array.from({ length: request.before - from }, (_, i) => ({
        r: [{ t: `old${from + i}` }],
      })),
    };
    const { nextBefore: _, ...source } = record;
    const prepared = prepareStreamHistory(source);
    if (!prepared.ok) throw new Error(prepared.code);
    offer(
      {
        kind: "history",
        generation: record.generation,
        requestId: request.requestId,
        before: request.before,
        capture: request.capture!,
      },
      prepared.bytes,
    );
    if (present) bridge.present(mobile.snapshot.vt!.log);
  }
  return {
    mobile,
    owner,
    bridge,
    controls,
    render,
    seed,
    page,
    offer,
    original: original.term,
    get log() {
      return mobile.snapshot.vt!.log as VtReplayLog;
    },
    get shown() {
      return shown;
    },
    request() {
      expect(mobile.requestOlder()).toBe(true);
      return controls.findLast(
        (m): m is Extract<StreamMessage, { type: "stream.history.get" }> =>
          m.type === "stream.history.get",
      )!;
    },
    async step() {
      const message = render.shift();
      if (!message) throw new Error("No render operation");
      await renderer.receive(message);
    },
    async settle() {
      let n = 0;
      while (render.length) {
        if (++n > 100) throw new Error("Renderer did not settle");
        await this.step();
      }
    },
    tick(value: number) {
      now = value;
      mobile.tick();
      pump();
    },
  };
}

describe("native phone history delivery and presentation", () => {
  it.each(["resize", "refresh"] as const)(
    "retains explicit refresh intent when a previously queued %s divider arrives first",
    async (reason) => {
      const h = harness();
      h.seed();
      await h.settle();
      expect(h.mobile.refreshNativeHistory()).toBe(true);
      h.seed({
        generation: 2,
        capture: "N".repeat(22),
        disposition: "discontinuity",
        reason,
        historyBefore: undefined,
        historyRows: undefined,
        historyProof: undefined,
      });
      await h.settle();
      expect(h.mobile.snapshot.historyRefreshPending).toBe(true);
      expect(h.mobile.snapshot.nativeHistoryRefreshable).toBe(false);
      h.seed({ generation: 3, capture: "R".repeat(22), disposition: "replace", reason: "refresh" });
      await h.settle();
      expect(h.mobile.snapshot.status).toBe("live");
      expect(h.mobile.snapshot.error).toBeUndefined();
      expect(h.mobile.snapshot.historyRefreshPending).toBe(false);
      expect(h.mobile.snapshot.historyStatus).toBe("ready");
    },
  );
  it("keeps the explicit refresh deadline across an intervening multi-chunk divider", async () => {
    const h = harness();
    h.seed();
    await h.settle();
    expect(h.mobile.refreshNativeHistory()).toBe(true);
    h.seed(
      {
        generation: 2,
        capture: "N".repeat(22),
        disposition: "discontinuity",
        reason: "resize",
        historyBefore: undefined,
        historyRows: undefined,
        historyProof: undefined,
      },
      "x".repeat(100000),
    );
    await h.settle();
    expect(h.log.generation).toBe(2);
    expect(h.mobile.snapshot.historyRefreshPending).toBe(true);
    h.tick(30000);
    expect(h.mobile.snapshot.status).toBe("closed");
    expect(h.mobile.snapshot.error).toBe("stalled");
  });

  it.each([false, true])(
    "captures the intact visible parser after an obsolete hidden build settles (failed=%s)",
    async (failed) => {
      const h = harness();
      h.seed();
      await h.settle();
      h.page(h.request());
      h.tick(600);
      const command = h.render[0]!.checkpoint!;
      if (command.kind !== "restore" || !command.nativePage)
        throw new Error("Missing hidden rebuild");
      if (failed) command.nativePage.proof = "0".repeat(64);
      await h.step();
      const next = new VtReplayLog(
        {
          ...h.log.meta,
          generation: 2,
          capture: "N".repeat(22),
          disposition: "discontinuity",
          reason: "resize",
          historyBefore: undefined,
          historyRows: undefined,
          historyProof: undefined,
        },
        bytes(`${VT_CONTINUATION_PREAMBLE}NEW`),
        h.log.owner,
      );
      h.bridge.present(next);
      await h.settle();
      expect(next.history?.rows).toBeGreaterThan(0);
      expect(next.renderedOffset).toBe(0);
      expect(lines(h.shown)).toContain("NEW");
      expect(lines(h.shown)).toContain("new4");
    },
  );
  it("does not replay a visible write twice when its ACK races a page and that page fails", async () => {
    const h = harness();
    h.seed();
    await h.settle();
    const request = h.request();
    const data = bytes("\r\nONCE");
    h.offer({ kind: "vt", generation: 1, offset: 0 }, data);
    h.bridge.present(h.log); // Admitted to the original visible renderer, ACK still pending.
    h.page(request, 2, false); // React has not delivered the revision change to the bridge yet.
    await h.step(); // Old visible parser ACK must retain its exact progress before rebuilding.
    const command = h.render[0]!.checkpoint!;
    if (command.kind !== "restore" || !command.nativePage)
      throw new Error("Missing hidden rebuild");
    command.nativePage.proof = "0".repeat(64);
    await h.settle();
    expect(h.shown).toBe(h.original);
    expect(lines(h.shown).filter((line) => line === "ONCE")).toHaveLength(1);
    expect(h.log.appliedOffset).toBe(data.length);
    expect(h.mobile.snapshot.status).toBe("live");
  });
  it("keeps live output when the hidden renderer cannot be allocated", async () => {
    const h = harness(extensions, true);
    h.seed();
    await h.settle();
    h.page(h.request());
    h.tick(600);
    await h.settle();
    expect(h.shown).toBe(h.original);
    expect(h.mobile.snapshot.status).toBe("live");
    expect(h.mobile.snapshot.error).toBeUndefined();
    expect(h.mobile.snapshot.historyStatus).toBe("reset");
  });
  it("does not claim native history ended when a seed cannot supply a row proof", async () => {
    const h = harness();
    h.seed({ historyBefore: undefined, historyRows: undefined, historyProof: undefined });
    expect(h.mobile.snapshot.nativeHistoryRefreshable).toBe(false);
    await h.settle();
    expect(h.mobile.snapshot.historyStatus).toBe("reset");
    expect(h.mobile.snapshot.nativeHistoryRefreshable).toBe(true);
    expect(h.mobile.requestOlder()).toBe(false);
  });
  it("discards a failed page and catches the original visible parser up without closing output", async () => {
    const h = harness();
    h.seed();
    await h.settle();
    h.page(h.request());
    h.tick(600);
    const command = h.render[0]!.checkpoint!;
    if (command.kind !== "restore" || !command.nativePage)
      throw new Error("Missing hidden rebuild");
    command.nativePage.proof = "0".repeat(64);
    h.offer({ kind: "vt", generation: 1, offset: 0 }, bytes("\r\nSTILL-LIVE"));
    await h.settle();
    expect(h.shown).toBe(h.original);
    expect(lines(h.shown)[0]).toBe("new4");
    expect(lines(h.shown).at(-1)).toBe("STILL-LIVE");
    expect(h.mobile.snapshot.status).toBe("live");
    expect(h.mobile.snapshot.error).toBeUndefined();
    expect(h.mobile.snapshot.historyStatus).toBe("reset");
    expect(h.mobile.snapshot.nativeHistoryRefreshable).toBe(true);
    expect(h.log.appliedOffset).toBe(bytes("\r\nSTILL-LIVE").length);
  });
  it("commits live history clearing during a rebuild and only retires older paging", async () => {
    const h = harness();
    h.seed();
    await h.settle();
    h.page(h.request());
    h.tick(600);
    h.offer({ kind: "vt", generation: 1, offset: 0 }, bytes("\x1b[3J"));
    await h.settle();
    expect(h.shown).not.toBe(h.original);
    expect(lines(h.shown)).toEqual(["live0", "live1", "live2", "live3"]);
    expect(h.mobile.snapshot.status).toBe("live");
    expect(h.mobile.snapshot.error).toBeUndefined();
    expect(h.mobile.snapshot.historyStatus).toBe("reset");
    expect(h.log.appliedOffset).toBe(bytes("\x1b[3J").length);
  });
  it("retries temporary source congestion without replacing loaded history", async () => {
    const h = harness();
    h.seed();
    await h.settle();
    const request = h.request();
    h.mobile.receive(
      {
        type: "stream.error",
        subscriptionId: SUB,
        requestId: request.requestId,
        code: "history-unavailable",
      },
      200,
    );
    expect(h.mobile.snapshot.historyStatus).toBe("unavailable");
    expect(h.log.nativeHistoryStopped).toBe(false);
    expect(h.request()).toMatchObject({ before: request.before, capture: request.capture });
  });
  it("pins the normal prefix before an initial seed enters the alternate screen", async () => {
    const h = harness();
    h.seed({}, `${seedText}\x1b[?1049h\x1b[HALTERNATE`);
    await h.settle();
    expect(h.shown.buffer.active.type).toBe("alternate");
    expect(h.log.olderBefore).toBe(4);
    h.page(h.request());
    h.tick(600);
    await h.settle();
    expect(h.log.olderBefore).toBe(2);
    expect(lines(h.shown).slice(0, 4)).toEqual(["old2", "old3", "new4", "new5"]);
    expect(h.shown.buffer.active.type).toBe("alternate");
    expect(h.shown.buffer.active.getLine(0)?.translateToString(true)).toBe("ALTERNATE");
  });
  it("requires rendered row proof and top intent, ACKs receipt early, and applies only after atomic presentation", async () => {
    const h = harness();
    h.seed();
    expect(h.mobile.requestOlder()).toBe(false);
    await h.settle();
    expect(h.mobile.snapshot.historyStatus).toBe("ready");
    expect(h.controls.some((m) => m.type === "stream.history.get")).toBe(false);
    h.tick(50);
    const request = h.request();
    expect(request).toMatchObject({ before: 4, capture: CAP, generation: 1 });
    const ackCount = h.controls.filter((m) => m.type === "stream.ack").length;
    h.page(request);
    h.tick(600);
    expect(h.controls.filter((m) => m.type === "stream.ack").length).toBeGreaterThan(ackCount);
    expect(h.log.olderBefore).toBeNull();
    expect(h.mobile.requestOlder()).toBe(false);
    expect(h.shown).toBe(h.original);
    expect(lines(h.shown)[0]).toBe("new4");
    h.offer({ kind: "vt", generation: 1, offset: 0 }, bytes("\r\nLATER"));
    while (h.render[0]?.checkpoint?.kind !== "present") await h.step();
    expect(h.log.appliedOffset).toBe(0);
    expect(h.shown).toBe(h.original);
    await h.step();
    expect(h.log.appliedOffset).toBe(bytes("\r\nLATER").length);
    expect(h.log.olderBefore).toBe(2);
    expect(lines(h.shown)).toEqual([
      "old2",
      "old3",
      "new4",
      "new5",
      "live0",
      "live1",
      "live2",
      "live3",
      "LATER",
    ]);
    expect(h.mobile.snapshot.historyStatus).toBe("ready");
    h.page(h.request());
    await h.settle();
    h.tick(1200);
    expect(lines(h.shown).slice(0, 4)).toEqual(["old0", "old1", "old2", "old3"]);
    expect(h.mobile.snapshot.historyStatus).toBe("end");
  });
  it("stops on an expired capture and refreshes only after explicit intent", async () => {
    const h = harness();
    h.seed();
    await h.settle();
    const request = h.request();
    h.mobile.receive(
      {
        type: "stream.error",
        subscriptionId: SUB,
        code: "history-reset",
        requestId: request.requestId,
      },
      200,
    );
    expect(h.mobile.snapshot.historyStatus).toBe("reset");
    expect(h.mobile.requestOlder()).toBe(false);
    expect(h.controls.some((m) => m.type === "stream.refresh")).toBe(false);
    expect(h.mobile.refreshNativeHistory()).toBe(true);
    expect(h.controls.at(-1)).toMatchObject({ type: "stream.refresh", history: true });
    h.seed({ generation: 2, capture: "N".repeat(22), disposition: "replace", reason: "refresh" });
    await h.settle();
    expect(h.owner.notice).toBe("history-refresh");
    expect(h.mobile.snapshot.historyStatus).toBe("ready");
    h.page(request);
    expect(h.log.pendingPrepend).toBeNull();
    expect(lines(h.shown)[0]).toBe("new4");
    expect(h.mobile.snapshot.status).toBe("live");
  });
  it("preserves loaded rows and stops when a history request times out", async () => {
    const h = harness();
    h.seed();
    await h.settle();
    h.request();
    h.tick(30000);
    expect(h.mobile.snapshot.historyStatus).toBe("reset");
    expect(h.log.nativeHistoryStopped).toBe(true);
    expect(lines(h.shown)[0]).toBe("new4");
  });
  it("refuses an unsolicited full replacement and unnegotiated native metadata", async () => {
    const h = harness();
    h.seed();
    await h.settle();
    h.seed({ generation: 2, capture: "N".repeat(22), disposition: "replace", reason: "refresh" });
    expect(h.mobile.snapshot.error).toBe("invalid-transfer");
    const old = harness([...CONTINUATION_EXTENSIONS]);
    old.seed();
    expect(old.mobile.snapshot.error).toBe("invalid-transfer");
  });
  it("fails closed on row proof mismatch without requesting older rows", async () => {
    const h = harness();
    h.seed({}, seedText.replace("new4", "wrong"));
    await h.settle();
    expect(h.mobile.snapshot.historyStatus).toBe("reset");
    expect(h.mobile.requestOlder()).toBe(false);
    expect(lines(h.shown)[0]).toBe("wrong");
  });
});
