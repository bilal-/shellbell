import { nativeHistoryProof, VT_CONTINUATION_PREAMBLE } from "@shellbell/protocol";
import { SerializeAddon } from "@xterm/addon-serialize";
import { Terminal } from "@xterm/headless";
import { afterEach, describe, expect, it } from "vitest";
import { encodeNativeHistoryPage } from "../src/terminal/vt-native-page";
import { VtRenderer } from "../src/terminal/vt-renderer";
import {
  encodeVtBytes,
  type VtCheckpointCommand,
  type VtRendererEvent,
} from "../src/terminal/vt-wire";

const terminals: Terminal[] = [];
afterEach(() => {
  for (const term of terminals.splice(0)) term.dispose();
});
const rows = (term: Terminal) =>
  Array.from({ length: term.buffer.normal.length }, (_, i) =>
    term.buffer.normal.getLine(i)!.translateToString(true),
  );
const bytes = (text: string) => new TextEncoder().encode(text);
function terminal() {
  const term = new Terminal({ cols: 20, rows: 4, scrollback: 10000, allowProposedApi: true });
  const serializer = new SerializeAddon();
  term.loadAddon(serializer as unknown as Parameters<Terminal["loadAddon"]>[0]);
  terminals.push(term);
  return { term, serializer };
}
const native = { rows: 2, proof: nativeHistoryProof(20, ["new4", "new5"])! };
const seed = `${VT_CONTINUATION_PREAMBLE}new4\r\nnew5\r\nlive0\r\nlive1\r\nlive2\r\nlive3`;
const page = encodeNativeHistoryPage([{ r: [{ t: "old2" }] }, { r: [{ t: "old3" }] }], 20)!;

function harness() {
  const original = terminal();
  let shown = original.term;
  let hidden: Terminal | undefined;
  const events: VtRendererEvent[] = [];
  const presented: number[] = [];
  let discarded = 0;
  let sequence = 0;
  const renderer = new VtRenderer(
    original.term,
    original.serializer,
    "doc",
    (event) => events.push(event),
    () => {},
    () => {
      const next = terminal();
      hidden = next.term;
      return {
        ...next,
        present: (count) => {
          presented.push(count);
          shown = next.term;
        },
        discard: () => {
          discarded++;
          next.term.dispose();
        },
      };
    },
  );
  const send = (checkpoint: VtCheckpointCommand, data: Uint8Array = new Uint8Array(), epoch = 1) =>
    renderer.receive({
      document: "doc",
      epoch,
      sequence: ++sequence,
      checkpoint,
      data: encodeVtBytes(data),
    });
  const start = async () => {
    await send({
      kind: "restore",
      cols: 20,
      rows: 4,
      history: { bytes: 0, rows: 0, dropped: false },
    });
    await send(
      { kind: "seed", complete: true, native: { ...native, precedingRows: 0 } },
      bytes(seed),
    );
  };
  const begin = async (proof = page.proof) => {
    await send(
      {
        kind: "restore",
        cols: 20,
        rows: 4,
        history: { bytes: page.data.length, rows: page.rows, dropped: false },
        nativePage: { rows: page.rows, proof },
      },
      undefined,
      2,
    );
  };
  return {
    original: original.term,
    renderer,
    events,
    presented,
    send,
    start,
    begin,
    get shown() {
      return shown;
    },
    get hidden() {
      return hidden!;
    },
    get discarded() {
      return discarded;
    },
  };
}

describe("hidden native history rebuild", () => {
  it("keeps the visible terminal responsive until the verified seed and live tail are presented", async () => {
    const f = harness();
    await f.start();
    expect(f.events).toContainEqual(
      expect.objectContaining({ type: "vt-native-proof", valid: true }),
    );
    const original = rows(f.original);
    await f.begin();
    expect(f.shown).toBe(f.original);
    expect(f.renderer.rebuilding).toBe(false);
    f.original.scrollToLine(0);
    expect(f.original.buffer.normal.viewportY).toBe(0);
    await f.send({ kind: "history", offset: 0 }, page.data, 2);
    expect(rows(f.original)).toEqual(original);
    await f.send(
      { kind: "seed", complete: true, native: { ...native, precedingRows: 2 } },
      bytes(seed),
      2,
    );
    await f.send({ kind: "tail" }, bytes("\r\nAPPENDED"), 2);
    expect(f.presented).toEqual([]);
    expect(rows(f.original)).toEqual(original);
    expect(await f.send({ kind: "present" }, undefined, 2)).toBe(true);
    expect(f.shown).toBe(f.hidden);
    expect(f.presented).toEqual([2]);
    expect(rows(f.shown)).toEqual(["old2", "old3", ...original, "APPENDED"]);
    expect(f.events.filter((event) => event.type === "vt-error")).toEqual([]);
  });

  it("does not accept matching counts when native text rows differ", async () => {
    const f = harness();
    await f.send({
      kind: "restore",
      cols: 20,
      rows: 4,
      history: { bytes: 0, rows: 0, dropped: false },
    });
    await f.send(
      { kind: "seed", complete: true, native: { ...native, precedingRows: 0 } },
      bytes(seed.replace("new4", "wrong")),
    );
    expect(f.events).toContainEqual(
      expect.objectContaining({ type: "vt-native-proof", valid: false }),
    );
  });

  it("discards a page with a bad physical proof while preserving the visible buffer", async () => {
    const f = harness();
    await f.start();
    const original = rows(f.original);
    await f.begin("0".repeat(64));
    expect(await f.send({ kind: "history", offset: 0 }, page.data, 2)).toBe(false);
    expect(f.discarded).toBe(1);
    expect(f.shown).toBe(f.original);
    expect(rows(f.original)).toEqual(original);
    expect(f.presented).toEqual([]);
  });

  it("presents current output even when its bytes erase the older prefix, and stops paging", async () => {
    const f = harness();
    await f.start();
    await f.begin();
    await f.send({ kind: "history", offset: 0 }, page.data, 2);
    await f.send(
      { kind: "seed", complete: true, native: { ...native, precedingRows: 2 } },
      bytes(seed),
      2,
    );
    await f.send({ kind: "tail" }, bytes("\x1b[3J"), 2);
    expect(await f.send({ kind: "present" }, undefined, 2)).toBe(true);
    expect(f.presented).toEqual([2]);
    expect(f.shown).toBe(f.hidden);
    expect(f.events).toContainEqual(
      expect.objectContaining({ type: "vt-native-proof", valid: false }),
    );
  });

  it("requires seed verification before presenting an older page", async () => {
    const f = harness();
    await f.start();
    await f.begin();
    await f.send({ kind: "history", offset: 0 }, page.data, 2);
    await f.send({ kind: "seed", complete: true }, bytes(seed), 2);
    expect(await f.send({ kind: "present" }, undefined, 2)).toBe(false);
    expect(f.presented).toEqual([]);
  });

  it("discards an unfinished build when a new source replaces it", async () => {
    const f = harness();
    await f.start();
    await f.begin();
    expect(
      await f.send(
        { kind: "restore", cols: 20, rows: 4, history: { bytes: 0, rows: 0, dropped: false } },
        undefined,
        3,
      ),
    ).toBe(true);
    expect(f.discarded).toBe(1);
    expect(await f.send({ kind: "seed", complete: true }, bytes("fresh"), 3)).toBe(true);
    expect(rows(f.shown)[0]).toBe("fresh");
  });
});
