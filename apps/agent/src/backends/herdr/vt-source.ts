import { EventEmitter } from "node:events";
import type { Line } from "@shellbell/protocol";
import type { Logger } from "../../log.js";
import {
  type AgentState,
  SessionGone,
  type VtSeed,
  type VtSource,
  type VtSourceEnd,
} from "../types.js";
import { lineAnsi } from "./ansi.js";
import { GONE_CODES, HerdrError } from "./client.js";
import { fakeCursor } from "./convert.js";
import { exactPhysicalRows, type HerdrHistoryFacts, parseHistoryFacts } from "./history.js";

/** Herdr returns at most this many rows per read, the screen included. */
export const HERDR_READ_LINES = 1000;
/** Consecutive failed polls before the view falls back to snapshots. */
const MAX_FAILURES = 20;
/** Polls in a row that could not take a consistent seed, about ten seconds. */
const MAX_SEED_ATTEMPTS = 50;

export interface HerdrVtPane {
  paneId: string;
  terminalId: string;
  cols: number;
  rows: number;
  agentStatus: AgentState;
  /** Herdr recognises an agent in this pane. */
  agent: boolean;
}

export interface HerdrVtSourceOptions {
  request: <T>(method: string, params: Record<string, unknown>) => Promise<T>;
  /** The pane as the backend currently knows it; undefined once it is gone. */
  pane: () => HerdrVtPane | undefined;
  log: Logger;
  pollMs?: number;
}

interface Frame {
  facts: HerdrHistoryFacts;
  /** Visible rows, without the blank rows Herdr leaves off the end. */
  visible: Line[];
  /** The rows just above the visible ones, oldest first. */
  above: Line[];
}

class Unsettled extends Error {}

/**
 * Herdr's pane as a raw stream. Herdr offers no output stream with its scrollback, so this source
 * builds one: a seed from Herdr's recent rows, then redraws of the rows that changed, polled.
 *
 * Rows that scroll off the screen into Herdr's scrollback are written above the screen so they
 * scroll into the phone's history as well. Agents such as Claude Code and Codex draw on the
 * alternate screen and keep their transcript there; Herdr reads that transcript only while the
 * agent is idle, so a fresh seed is taken each time the agent becomes idle.
 */
export class HerdrVtSource
  extends EventEmitter<{ seed: [VtSeed]; bytes: [Uint8Array, number]; end: [VtSourceEnd] }>
  implements VtSource
{
  private readonly log: Logger;
  private generation = 0;
  private historyLines = HERDR_READ_LINES;
  private timer: NodeJS.Timeout | null = null;
  private busy = false;
  private seedWanted = false;
  private ended = false;
  private failures = 0;
  private seedFailures = 0;
  private shown:
    | {
        cols: number;
        rows: number;
        history: number;
        screen: string[];
        cursor: string;
        idle: boolean;
      }
    | undefined;

  constructor(private readonly opts: HerdrVtSourceOptions) {
    super();
    this.log = opts.log.child({ backend: "herdr", stream: "vt" });
  }

  async start(historyLines?: number): Promise<void> {
    if (historyLines !== undefined) this.historyLines = historyLines;
    await this.reseed();
  }

  async reseed(historyLines?: number): Promise<void> {
    if (historyLines !== undefined) this.historyLines = historyLines;
    this.seedWanted = true;
    await this.run();
  }

  close(): void {
    this.end(undefined);
  }

  /** One poll or seed at a time; the next poll is scheduled when it finishes. */
  private async run(): Promise<void> {
    if (this.ended || this.busy) return;
    this.busy = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    try {
      if (this.seedWanted) await this.seed();
      else await this.poll();
      this.failures = 0;
    } catch (err) {
      if (err instanceof SessionGone || (err instanceof HerdrError && GONE_CODES.has(err.code))) {
        this.end("pane-gone");
      } else if (!(err instanceof Unsettled) && ++this.failures >= MAX_FAILURES) {
        this.log.debug("herdr vt stream failed", {
          error: err instanceof Error ? err.name : "unknown",
        });
        this.end("failed");
      }
    } finally {
      this.busy = false;
      if (!this.ended) {
        this.timer = setTimeout(() => void this.run(), this.opts.pollMs ?? 200);
        this.timer.unref?.();
      }
    }
  }

  private current(): HerdrVtPane {
    const pane = this.opts.pane();
    if (!pane) {
      this.end("pane-gone");
      throw new Unsettled();
    }
    return pane;
  }

  private async facts(pane: HerdrVtPane): Promise<HerdrHistoryFacts> {
    const result = await this.opts.request("pane.get", { pane_id: pane.paneId });
    const facts = parseHistoryFacts(result, pane.paneId, pane.terminalId);
    if (!facts) throw new Unsettled();
    return facts;
  }

  /**
   * The visible rows and `above(facts)` rows over them, between two identical sets of scroll
   * facts, so the rows above are exactly the ones before the screen. Output that changes the
   * facts in between makes it try again on a later poll.
   */
  private async frame(
    pane: HerdrVtPane,
    above: (facts: HerdrHistoryFacts) => number,
  ): Promise<Frame> {
    const before = await this.facts(pane);
    // Someone scrolled the pane on the computer; wait until it is back at the bottom.
    if (before.offset !== 0) throw new Unsettled();
    const read = await this.opts.request("pane.read", {
      pane_id: pane.paneId,
      source: "visible",
      format: "ansi",
    });
    const visible = exactPhysicalRows(read, {
      paneId: pane.paneId,
      source: "visible",
      rows: pane.rows,
      cols: pane.cols,
      minRows: 0,
    });
    if (!visible) throw new Unsettled();
    const count = above(before);
    let rows: Line[] = [];
    if (count > 0 && visible.length > 0) {
      const lines = Math.min(HERDR_READ_LINES, count + visible.length);
      const recent = exactPhysicalRows(
        await this.opts.request("pane.read", {
          pane_id: pane.paneId,
          source: "recent",
          format: "ansi",
          lines,
        }),
        {
          paneId: pane.paneId,
          source: "recent",
          rows: lines,
          cols: pane.cols,
          minRows: visible.length,
        },
      );
      if (!recent || !sameRows(recent.slice(-visible.length), visible)) throw new Unsettled();
      rows = recent.slice(0, -visible.length);
    }
    const after = await this.facts(pane);
    if (!sameFacts(before, after)) throw new Unsettled();
    return { facts: after, visible, above: rows };
  }

  private async seed(): Promise<void> {
    const pane = this.current();
    let frame: Frame;
    try {
      // An idle agent's transcript reaches past Herdr's own scrollback; ask for all of it.
      frame = await this.frame(pane, (facts) =>
        Math.min(
          pane.agent && idle(pane.agentStatus) ? this.historyLines : facts.history,
          this.historyLines,
        ),
      );
    } catch (err) {
      if (err instanceof Unsettled && ++this.seedFailures >= MAX_SEED_ATTEMPTS)
        this.end("unsettled");
      throw err;
    }
    this.seedFailures = 0;
    const screen = screenRows(frame.visible, pane.rows);
    const cursor = cursorAt(frame.visible, pane.cols);
    const rows = [...frame.above.map(lineAnsi), ...screen];
    this.seedWanted = false;
    this.generation++;
    this.shown = {
      cols: pane.cols,
      rows: pane.rows,
      history: frame.facts.history,
      screen,
      cursor,
      idle: idle(pane.agentStatus),
    };
    this.emit("seed", {
      generation: this.generation,
      cols: pane.cols,
      rows: pane.rows,
      data: `\x1bc${rows.join("\r\n")}${cursor}`,
    });
  }

  private async poll(): Promise<void> {
    const shown = this.shown;
    const pane = this.current();
    if (!shown || pane.cols !== shown.cols || pane.rows !== shown.rows) {
      this.seedWanted = true;
      return;
    }
    const nowIdle = idle(pane.agentStatus);
    if (pane.agent && nowIdle && !shown.idle) {
      // The agent finished; its transcript now includes the latest turn.
      this.seedWanted = true;
      return;
    }
    shown.idle = nowIdle;
    let reseed = false;
    const frame = await this.frame(pane, (facts) => {
      const added = facts.history - shown.history;
      // Scrollback was cleared, or more scrolled off than one read returns.
      reseed = added < 0 || added + pane.rows > HERDR_READ_LINES;
      return reseed ? 0 : added;
    });
    // A blank screen gives the rows above nothing to be anchored to.
    if (reseed || frame.above.length !== frame.facts.history - shown.history) {
      this.seedWanted = true;
      return;
    }
    const scrolled = frame.above;
    const screen = screenRows(frame.visible, pane.rows);
    const cursor = cursorAt(frame.visible, pane.cols);
    let data = "";
    if (scrolled.length > 0) {
      // Written from the top, the first rows scroll off into the phone's history.
      const rows = [...scrolled.map(lineAnsi), ...screen];
      data = `\x1b[H${rows.map((row) => `\x1b[2K${row}`).join("\r\n")}`;
    } else {
      for (let y = 0; y < screen.length; y++) {
        if (screen[y] !== shown.screen[y]) data += `\x1b[${y + 1};1H\x1b[2K${screen[y]}`;
      }
    }
    if (data || cursor !== shown.cursor) data += cursor;
    shown.history = frame.facts.history;
    shown.screen = screen;
    shown.cursor = cursor;
    if (data) this.emit("bytes", new TextEncoder().encode(data), this.generation);
  }

  private end(reason: VtSourceEnd | undefined): void {
    if (this.ended) return;
    this.ended = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    if (reason) this.emit("end", reason);
  }
}

function idle(status: AgentState): boolean {
  return status === "idle" || status === "done";
}

function sameFacts(a: HerdrHistoryFacts, b: HerdrHistoryFacts): boolean {
  return (
    a.revision === b.revision &&
    a.history === b.history &&
    a.viewportRows === b.viewportRows &&
    a.offset === b.offset
  );
}

function sameRows(a: readonly Line[], b: readonly Line[]): boolean {
  return a.length === b.length && a.every((line, i) => lineAnsi(line) === lineAnsi(b[i]!));
}

/** Every screen row as bytes, the blank rows Herdr left off included. */
function screenRows(visible: readonly Line[], rows: number): string[] {
  return Array.from({ length: rows }, (_, y) => lineAnsi(visible[y] ?? { r: [] }));
}

/** Herdr reports no cursor; like snapshots, it goes after the last text on the screen. */
function cursorAt(visible: Line[], cols: number): string {
  const { x, y } = fakeCursor(visible, cols);
  return `\x1b[${y + 1};${x + 1}H`;
}
