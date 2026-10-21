import xterm from "@xterm/headless";
import { afterEach, describe, expect, it, vi } from "vitest";
import { HerdrError } from "../src/backends/herdr/client.js";
import { HerdrVtSource } from "../src/backends/herdr/vt-source.js";
import type { AgentState, VtSourceEnd } from "../src/backends/types.js";
import { createLogger } from "../src/log.js";

const { Terminal } = xterm;

/** A Herdr pane: host scrollback, an agent transcript, and a screen of `rows` rows. */
class FakePane {
  history: string[] = [];
  transcript: string[] = [];
  screen: string[] = [];
  agent = false;
  agentStatus: AgentState = "unknown";
  offset = 0;
  viewportRows: number | undefined;
  raceRevisions = false;
  readFailures = 0;
  detectionUnavailable = false;
  missingScroll = false;
  private revision = 1;
  gone = false;
  reads: string[] = [];
  constructor(
    public cols = 20,
    readonly rows = 4,
  ) {}

  /** The screen as Herdr reads it: trailing blank rows left off. */
  private visible(): string[] {
    const rows = [...this.screen];
    while (rows.length > 0 && rows.at(-1) === "") rows.pop();
    return rows;
  }

  async request<T>(method: string, params: Record<string, unknown>): Promise<T> {
    if (this.gone) throw new HerdrError("pane_not_found", "gone");
    const pane = { pane_id: "w1:p1", terminal_id: "t1" };
    if (method === "pane.get") {
      return {
        type: "pane_info",
        pane: {
          ...pane,
          revision: this.raceRevisions ? ++this.revision : this.revision,
          ...(!this.missingScroll && {
            scroll: {
              offset_from_bottom: this.offset,
              max_offset_from_bottom: this.history.length,
              viewport_rows: this.viewportRows ?? this.rows,
            },
          }),
        },
      } as T;
    }
    const source = params.source as string;
    if (source === "detection" && this.detectionUnavailable)
      throw new Error("synthetic bottom read failure");
    if (source === "visible" && this.readFailures > 0) {
      this.readFailures--;
      throw new Error("synthetic read failure");
    }
    this.reads.push(source);
    const visible = this.visible();
    const above =
      this.agent && (this.agentStatus === "idle" || this.agentStatus === "done")
        ? this.transcript
        : this.history;
    const rows =
      source === "visible" || source === "detection"
        ? visible
        : [...above, ...visible].slice(-(params.lines as number));
    return {
      type: "pane_read",
      read: {
        ...pane,
        source,
        format: source === "detection" ? "text" : "ansi",
        text: rows.join("\n"),
        truncated: false,
      },
    } as T;
  }

  source() {
    return new HerdrVtSource({
      request: (method, params) => this.request(method, params),
      pane: () =>
        this.gone
          ? undefined
          : {
              paneId: "w1:p1",
              terminalId: "t1",
              cols: this.cols,
              rows: this.rows,
              agentStatus: this.agentStatus,
              agent: this.agent,
            },
      log: createLogger({ stdout: false }),
      pollMs: 5,
    });
  }
}

/** The phone's xterm, fed only what the source emits. */
class Phone {
  term: InstanceType<typeof Terminal> | undefined;
  seeds = 0;
  writes: string[] = [];
  ended: VtSourceEnd | undefined;
  private queue = Promise.resolve();
  constructor(source: HerdrVtSource) {
    source.on("seed", (seed) => {
      this.seeds++;
      this.queue = this.queue.then(() => {
        this.term?.dispose();
        this.term = new Terminal({ cols: seed.cols, rows: seed.rows, allowProposedApi: true });
        return this.write(seed.data);
      });
    });
    source.on("bytes", (data) => {
      const text = new TextDecoder().decode(data);
      this.writes.push(text);
      this.queue = this.queue.then(() => this.write(text));
    });
    source.on("end", (reason) => {
      this.ended = reason;
    });
  }
  private write(data: string) {
    const term = this.term!;
    return new Promise<void>((resolve) => term.write(data, resolve));
  }
  /** Every line, history first, with trailing blank screen rows dropped. */
  async lines(): Promise<string[]> {
    await this.queue;
    const buffer = this.term!.buffer.active;
    const out = Array.from({ length: buffer.length }, (_, y) =>
      buffer.getLine(y)!.translateToString(true),
    );
    while (out.length > 0 && out.at(-1) === "") out.pop();
    return out;
  }
}

async function until(check: () => Promise<boolean> | boolean, timeoutMs = 2000) {
  const deadline = Date.now() + timeoutMs;
  while (!(await check())) {
    if (Date.now() > deadline) throw new Error("condition not reached");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

let source: HerdrVtSource | undefined;
afterEach(() => source?.close());

describe("HerdrVtSource", () => {
  it("retries a transient read error after each healthy idle output wait", async () => {
    vi.useFakeTimers();
    const pane = new FakePane();
    pane.screen = ["quiet prompt"];
    let waits = 0;
    const source = new HerdrVtSource({
      request: (method, params) => {
        if (method === "events.wait") {
          waits++;
          return new Promise(() => {});
        }
        return pane.request(method, params);
      },
      pane: () => ({
        paneId: "w1:p1",
        terminalId: "t1",
        cols: pane.cols,
        rows: pane.rows,
        agentStatus: pane.agentStatus,
        agent: pane.agent,
      }),
      log: createLogger({ stdout: false }),
    });
    const ended = vi.fn();
    source.on("end", ended);
    try {
      await source.start();
      for (let attempt = 0; attempt < 2; attempt++) {
        pane.readFailures = 1;
        // The native wait's local deadline fires before the one failing read.
        await vi.advanceTimersByTimeAsync(2_001);
        expect(pane.readFailures).toBe(0);
        expect(ended).not.toHaveBeenCalled();
        await vi.advanceTimersByTimeAsync(200);
        expect(waits).toBe(attempt + 2);
        expect(ended).not.toHaveBeenCalled();
      }
    } finally {
      source.close();
      vi.useRealTimers();
    }
  });

  it.each([false, true])(
    "bounds repeated read errors by elapsed time (bottom read unavailable: %s)",
    async (detectionUnavailable) => {
      vi.useFakeTimers();
      const pane = new FakePane();
      pane.screen = ["last trustworthy screen"];
      const source = new HerdrVtSource({
        request: (method, params) => pane.request(method, params),
        pane: () => ({
          paneId: "w1:p1",
          terminalId: "t1",
          cols: pane.cols,
          rows: pane.rows,
          agentStatus: pane.agentStatus,
          agent: pane.agent,
        }),
        log: createLogger({ stdout: false }),
        pollMs: 200,
      });
      const ended = vi.fn();
      source.on("end", ended);
      try {
        await source.start();
        pane.readFailures = 100;
        pane.detectionUnavailable = detectionUnavailable;
        await vi.advanceTimersByTimeAsync(1_999);
        expect(ended).not.toHaveBeenCalled();
        await vi.advanceTimersByTimeAsync(201);
        expect(ended).toHaveBeenCalledExactlyOnceWith(
          detectionUnavailable ? "herdr-unreadable" : "failed",
        );
        expect(pane.readFailures).toBeGreaterThan(80);
      } finally {
        source.close();
        vi.useRealTimers();
      }
    },
  );

  it("wakes a settled frame on native output while bounding the wait", async () => {
    const pane = new FakePane();
    pane.screen = ["before"];
    const waits: { params: Record<string, unknown>; resolve: () => void }[] = [];
    const source = new HerdrVtSource({
      request: <T>(method: string, params: Record<string, unknown>): Promise<T> =>
        method === "events.wait"
          ? new Promise<T>((resolve) => waits.push({ params, resolve: () => resolve({} as T) }))
          : pane.request<T>(method, params),
      pane: () => ({
        paneId: "w1:p1",
        terminalId: "t1",
        cols: pane.cols,
        rows: pane.rows,
        agentStatus: pane.agentStatus,
        agent: pane.agent,
      }),
      log: createLogger({ stdout: false }),
    });
    const phone = new Phone(source);
    try {
      await source.start();
      await vi.waitFor(() => expect(waits).toHaveLength(1));
      expect(waits[0]?.params).toEqual({
        match_event: { event: "pane_output_changed", pane_id: "w1:p1", min_revision: 2 },
        timeout_ms: 1_800,
      });
      pane.screen = ["after"];
      waits[0]?.resolve();
      await vi.waitFor(() => expect(phone.writes.length).toBeGreaterThan(0));
      expect(await phone.lines()).toContain("after");
    } finally {
      source.close();
    }
  });

  it.each(["unknown_method", "unsupported_event_wait_match"])(
    "uses periodic polling when Herdr rejects output waits with %s",
    async (code) => {
      const pane = new FakePane();
      pane.screen = ["before"];
      let waits = 0;
      const source = new HerdrVtSource({
        request: <T>(method: string, params: Record<string, unknown>): Promise<T> => {
          if (method === "events.wait") {
            waits++;
            return Promise.reject(new HerdrError(code, "output wait unavailable"));
          }
          return pane.request<T>(method, params);
        },
        pane: () => ({
          paneId: "w1:p1",
          terminalId: "t1",
          cols: pane.cols,
          rows: pane.rows,
          agentStatus: pane.agentStatus,
          agent: pane.agent,
        }),
        log: createLogger({ stdout: false }),
      });
      const phone = new Phone(source);
      try {
        await source.start();
        await vi.waitFor(() => expect(waits).toBe(1));
        pane.screen = ["after"];
        await vi.waitFor(() => expect(phone.writes.length).toBeGreaterThan(0));
        expect(await phone.lines()).toContain("after");
        expect(waits).toBe(1);
      } finally {
        source.close();
      }
    },
  );

  it("seeds the phone with Herdr's scrollback above the screen", async () => {
    const pane = new FakePane();
    pane.history = ["h1", "h2", "h3"];
    pane.screen = ["$ ls", "a b", "$ ", ""];
    source = pane.source();
    const phone = new Phone(source);
    await source.start();
    expect(await phone.lines()).toEqual(["h1", "h2", "h3", "$ ls", "a b", "$"]);
  });

  it("moves rows that scroll off the screen into the phone's history", async () => {
    const pane = new FakePane();
    pane.screen = ["$ seq 1 5", "", "", ""];
    source = pane.source();
    const phone = new Phone(source);
    await source.start();
    pane.history = ["$ seq 1 5", "1", "2"];
    pane.screen = ["3", "4", "5", "$ "];
    await until(async () => (await phone.lines()).length === 7);
    expect(await phone.lines()).toEqual(["$ seq 1 5", "1", "2", "3", "4", "5", "$"]);
    expect(phone.seeds).toBe(1);
  });

  it("redraws only the rows that changed", async () => {
    const pane = new FakePane();
    pane.screen = ["top", "middle", "$ ", ""];
    source = pane.source();
    const phone = new Phone(source);
    await source.start();
    pane.screen = ["top", "middle", "$ echo", ""];
    await until(() => phone.writes.length > 0);
    expect(phone.writes.join("")).not.toContain("middle");
    expect(await phone.lines()).toEqual(["top", "middle", "$ echo"]);
  });

  it("takes a fresh seed with the transcript when an agent becomes idle", async () => {
    const pane = new FakePane();
    pane.agent = true;
    pane.agentStatus = "working";
    pane.transcript = ["> fix it", "Done."];
    pane.screen = ["working…", "", "", ""];
    source = pane.source();
    const phone = new Phone(source);
    await source.start();
    expect(await phone.lines()).toEqual(["working…"]);
    pane.agentStatus = "idle";
    pane.screen = ["> ", "", "", ""];
    await until(() => phone.seeds === 2);
    expect(await phone.lines()).toEqual(["> fix it", "Done.", ">"]);
  });

  it("waits while the pane is scrolled on the computer", async () => {
    const pane = new FakePane();
    pane.screen = ["one", "", "", ""];
    source = pane.source();
    const phone = new Phone(source);
    await source.start();
    pane.offset = 3;
    pane.screen = ["scrolled view", "", "", ""];
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(phone.writes).toEqual([]);
    pane.offset = 0;
    pane.screen = ["two", "", "", ""];
    await until(async () => (await phone.lines())[0] === "two");
  });

  it("switches a scrolled pane to its verified bottom snapshot", async () => {
    const pane = new FakePane();
    pane.history = ["old one", "old two", "old three"];
    pane.screen = ["one", "", "", ""];
    source = pane.source();
    const phone = new Phone(source);
    await source.start();
    pane.offset = 3;
    await until(() => phone.ended !== undefined, 4_000);
    expect(pane.reads).toContain("detection");
    expect(phone.ended).toBe("unsettled");
  });

  it("stalls when a scrolled pane has no verified bottom snapshot", async () => {
    const pane = new FakePane();
    pane.history = ["old one", "old two", "old three"];
    pane.screen = ["one", "", "", ""];
    pane.detectionUnavailable = true;
    source = pane.source();
    const phone = new Phone(source);
    await source.start();
    pane.offset = 3;
    await until(() => phone.ended !== undefined, 4_000);
    expect(phone.ended).toBe("herdr-unreadable");
  });

  it("falls back to snapshots when revisions race but a bottom read succeeds", async () => {
    const pane = new FakePane();
    pane.screen = ["busy", "", "", ""];
    pane.raceRevisions = true;
    source = pane.source();
    const phone = new Phone(source);
    await source.start();
    await until(() => phone.ended !== undefined, 4_000);
    expect(phone.ended).toBe("unsettled");
    expect(phone.seeds).toBe(0);
  });

  it("reseeds from pane.get viewport rows when the cached layout is stale", async () => {
    const pane = new FakePane();
    pane.screen = ["one", "two", "", ""];
    source = pane.source();
    const phone = new Phone(source);
    await source.start();
    expect(phone.term?.rows).toBe(4);
    pane.viewportRows = 2;
    await until(() => phone.seeds === 2);
    expect(phone.term?.rows).toBe(2);
  });

  it("stalls after repeated read errors when the snapshot probe also fails", async () => {
    const pane = new FakePane();
    pane.screen = ["busy", "", "", ""];
    pane.readFailures = Number.POSITIVE_INFINITY;
    pane.detectionUnavailable = true;
    source = pane.source();
    const phone = new Phone(source);
    await source.start();
    await until(() => phone.ended !== undefined, 4_000);
    expect(phone.ended).toBe("herdr-unreadable");
  });

  it("uses a bottom snapshot when pane.get omits scroll metrics", async () => {
    const pane = new FakePane();
    pane.screen = ["visible", "", "", ""];
    pane.missingScroll = true;
    source = pane.source();
    const phone = new Phone(source);
    await source.start();
    await until(() => phone.ended !== undefined, 4_000);
    expect(phone.ended).toBe("unsettled");
    expect(pane.reads).toContain("detection");
  });

  it("ends when the pane closes", async () => {
    const pane = new FakePane();
    pane.screen = ["x", "", "", ""];
    source = pane.source();
    const phone = new Phone(source);
    await source.start();
    pane.gone = true;
    await until(() => phone.ended !== undefined);
    expect(phone.ended).toBe("pane-gone");
  });
});

it("distinguishes an idle history replacement from resizing an already-idle agent", async () => {
  const pane = new FakePane();
  pane.agent = true;
  pane.agentStatus = "idle";
  pane.transcript = ["earlier turn"];
  pane.screen = ["prompt"];
  source = pane.source();
  const reasons: (string | undefined)[] = [];
  source.on("seed", (seed) => reasons.push(seed.continuation?.reason));
  await source.start();
  expect(reasons).toEqual(["herdr-idle"]);
  await source.reseed(500);
  expect(reasons).toEqual(["herdr-idle", "herdr-idle"]);
  pane.viewportRows = 3;
  await until(() => reasons.length === 3);
  expect(reasons[2]).toBe("resize");
});

it("delivers idle transcript history when width changes as the agent finishes", async () => {
  const pane = new FakePane();
  pane.agent = true;
  pane.agentStatus = "working";
  pane.screen = ["working"];
  source = pane.source();
  const seeds: { reason: string | undefined; data: string }[] = [];
  source.on("seed", (seed) => seeds.push({ reason: seed.continuation?.reason, data: seed.data }));
  await source.start();
  pane.cols = 18;
  pane.agentStatus = "idle";
  pane.transcript = ["finished turn"];
  pane.screen = ["prompt"];
  await until(() => seeds.length === 2);
  expect(seeds[1]!.reason).toBe("herdr-idle");
  expect(seeds[1]!.data).toContain("finished turn");
});
