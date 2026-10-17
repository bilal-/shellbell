import xterm from "@xterm/headless";
import { afterEach, describe, expect, it } from "vitest";
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
  gone = false;
  reads: string[] = [];
  constructor(
    readonly cols = 20,
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
          revision: 1,
          scroll: {
            offset_from_bottom: this.offset,
            max_offset_from_bottom: this.history.length,
            viewport_rows: this.rows,
          },
        },
      } as T;
    }
    const source = params.source as string;
    this.reads.push(source);
    const visible = this.visible();
    const above =
      this.agent && (this.agentStatus === "idle" || this.agentStatus === "done")
        ? this.transcript
        : this.history;
    const rows =
      source === "visible" ? visible : [...above, ...visible].slice(-(params.lines as number));
    return {
      type: "pane_read",
      read: { ...pane, source, format: "ansi", text: rows.join("\n"), truncated: false },
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

  it("keeps rows that scroll off once Herdr's history is full and its count stops growing", async () => {
    const pane = new FakePane();
    pane.history = ["h1", "h2", "h3"];
    pane.screen = ["s1", "s2", "s3", "$ "];
    source = pane.source();
    const phone = new Phone(source);
    await source.start();
    // Full scrollback: one row scrolls off, the oldest is dropped, the count stays at 3.
    pane.history = ["h2", "h3", "s1"];
    pane.screen = ["s2", "s3", "s4", "$ "];
    await until(async () => (await phone.lines()).includes("s4"));
    expect(await phone.lines()).toEqual(["h1", "h2", "h3", "s1", "s2", "s3", "s4", "$"]);
    expect(phone.seeds).toBe(1);
  });

  it("takes a fresh seed when a full history's screen was redrawn rather than scrolled", async () => {
    const pane = new FakePane();
    pane.history = ["h1", "h2", "h3"];
    pane.screen = ["a", "b", "c", "$ "];
    source = pane.source();
    const phone = new Phone(source);
    await source.start();
    pane.screen = ["x", "y", "z", "$ "];
    await until(() => phone.seeds === 2);
    expect(await phone.lines()).toEqual(["h1", "h2", "h3", "x", "y", "z", "$"]);
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
