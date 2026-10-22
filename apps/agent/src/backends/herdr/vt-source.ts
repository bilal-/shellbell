import { EventEmitter } from "node:events";
import { type Line, VT_CONTINUATION_PREAMBLE } from "@shellbell/protocol";
import type { Logger } from "../../log.js";
import {
  type AgentState,
  SessionGone,
  type VtSeed,
  type VtSource,
  type VtSourceEnd,
} from "../types.js";
import { lineAnsi } from "./ansi.js";
import { GONE_CODES, HerdrError, UNSUPPORTED_CODES } from "./client.js";
import { fakeCursor } from "./convert.js";
import { exactPhysicalRows, type HerdrHistoryFacts, parseHistoryFacts } from "./history.js";
import type { PaneReadResult } from "./types.js";
import { HerdrVtHistory, type HerdrVtHistoryFacts, nativeHistorySource } from "./vt-history.js";

/** Herdr returns at most this many rows per read, the screen included. */
export const HERDR_READ_LINES = 1000;
/** Consecutive failed polls before a verified snapshot probe or a stalled close. */
const MAX_FAILURES = 20;

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
  facts: HerdrVtHistoryFacts;
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
  readonly history: HerdrVtHistory;
  private generation = 0;
  private historyLines = HERDR_READ_LINES;
  private timer: NodeJS.Timeout | null = null;
  private busy = false;
  private seedWanted = false;
  private ended = false;
  private failures = 0;
  private readFailureSince: number | null = null;
  private waitSupported = true;
  private wakeSeq = 0;
  private seedReason: "resize" | "refresh" | "herdr-idle" | "source-gap" = "refresh";
  private lastSeedReason: "resize" | "refresh" | "herdr-idle" | "source-gap" = "refresh";
  private probing: Promise<{ generation: number; quiescent: boolean }> | null = null;
  readonly continuation = {
    cursor: "guessed" as const,
    alternate: "unknown" as const,
    probe: () => {
      this.probing ??= this.probe().finally(() => {
        this.probing = null;
      });
      return this.probing;
    },
  };
  private shown:
    | {
        cols: number;
        rows: number;
        history: number;
        screen: string[];
        cursor: string;
        idle: boolean;
        revision: number;
      }
    | undefined;

  constructor(private readonly opts: HerdrVtSourceOptions) {
    super();
    this.log = opts.log.child({ backend: "herdr", stream: "vt" });
    this.history = new HerdrVtHistory(opts);
  }

  async start(historyLines?: number): Promise<void> {
    if (historyLines !== undefined) this.historyLines = historyLines;
    await this.reseed();
  }

  async reseed(historyLines?: number): Promise<void> {
    this.history.invalidate();
    // Retrying an oversized idle seed with less history still replaces that idle capture.
    if (historyLines !== undefined && historyLines < this.historyLines)
      this.seedReason = this.lastSeedReason;
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
    ++this.wakeSeq;
    this.busy = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    try {
      if (this.seedWanted) await this.seed();
      else await this.poll();
      this.failures = 0;
      this.readFailureSince = null;
    } catch (err) {
      this.readFailureSince ??= Date.now();
      if (err instanceof SessionGone || (err instanceof HerdrError && GONE_CODES.has(err.code))) {
        this.end("pane-gone");
      } else if (Date.now() - this.readFailureSince >= 2_000) {
        // Count read errors and unsettled frames from the first failure, excluding a healthy
        // idle event wait. Counting retries alone grows too slow on native reads.
        // Only a verified bottom read permits the legacy snapshot fallback.
        const readable = await this.probeBottomSnapshot();
        if (!this.ended)
          this.end(
            readable ? (err instanceof Unsettled ? "unsettled" : "failed") : "herdr-unreadable",
          );
      } else if (!(err instanceof Unsettled) && ++this.failures >= MAX_FAILURES) {
        this.log.debug("herdr vt stream failed", {
          error: err instanceof Error ? err.name : "unknown",
        });
        const readable = await this.probeBottomSnapshot();
        if (!this.ended) this.end(readable ? "failed" : "herdr-unreadable");
      }
    } finally {
      this.busy = false;
      if (!this.ended) {
        if (
          this.opts.pollMs === undefined &&
          this.waitSupported &&
          this.shown &&
          !this.seedWanted &&
          this.readFailureSince === null
        ) {
          const pane = this.opts.pane();
          if (pane) void this.waitForOutput(this.wakeSeq, pane.paneId, this.shown.revision);
          else this.end("pane-gone");
        } else {
          this.schedulePoll(this.opts.pollMs ?? 200);
        }
      }
    }
  }

  private schedulePoll(delayMs: number): void {
    if (this.ended) return;
    this.timer = setTimeout(() => void this.run(), delayMs);
    this.timer.unref?.();
  }

  /** Wake on native output, but probe at least every two seconds even if an event is missed. */
  private async waitForOutput(seq: number, paneId: string, revision: number): Promise<void> {
    const started = Date.now();
    let timer: NodeJS.Timeout | undefined;
    try {
      await Promise.race([
        this.opts.request("events.wait", {
          match_event: {
            event: "pane_output_changed",
            pane_id: paneId,
            min_revision: revision + 1,
          },
          timeout_ms: 1_800,
        }),
        new Promise<void>((resolve) => {
          timer = setTimeout(resolve, 2_000);
          timer.unref?.();
        }),
      ]);
    } catch (err) {
      // Older Herdr releases do not expose events.wait. Keep their existing
      // 200 ms poll path, including when the probe fails for another reason.
      this.waitSupported = false;
      if (!(err instanceof HerdrError && UNSUPPORTED_CODES.has(err.code))) {
        this.log.debug("herdr output wait failed", {
          error: err instanceof Error ? err.name : "unknown",
        });
      }
    } finally {
      if (timer) clearTimeout(timer);
    }
    if (this.ended || seq !== this.wakeSeq) return;
    this.schedulePoll(Math.max(0, 200 - (Date.now() - started)));
  }

  private current(): HerdrVtPane {
    const pane = this.opts.pane();
    if (!pane) {
      this.end("pane-gone");
      throw new Unsettled();
    }
    return pane;
  }

  private async facts(pane: HerdrVtPane): Promise<HerdrVtHistoryFacts> {
    const result = await this.opts.request("pane.get", { pane_id: pane.paneId });
    const facts = parseHistoryFacts(result, pane.paneId, pane.terminalId);
    if (!facts) throw new Unsettled();
    return { ...facts, source: nativeHistorySource(result) };
  }

  private async probeBottomSnapshot(): Promise<boolean> {
    const probe = async (): Promise<boolean> => {
      try {
        const pane = this.current();
        const read = await this.opts.request<PaneReadResult>("pane.read", {
          pane_id: pane.paneId,
          source: "detection",
          format: "text",
        });
        if (
          read?.type !== "pane_read" ||
          read.read?.pane_id !== pane.paneId ||
          read.read.source !== "detection" ||
          read.read.format !== "text" ||
          read.read.truncated ||
          typeof read.read.text !== "string"
        )
          return false;
        const current = this.current();
        return current.paneId === pane.paneId && current.terminalId === pane.terminalId;
      } catch {
        return false;
      }
    };
    let timer: NodeJS.Timeout | undefined;
    try {
      return await Promise.race([
        probe(),
        new Promise<boolean>((resolve) => {
          timer = setTimeout(() => resolve(false), 1_000);
        }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
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
      rows: before.viewportRows,
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
    this.history.observe(pane, after);
    return { facts: after, visible, above: rows };
  }

  private async seed(): Promise<void> {
    const pane = this.current();
    // An idle agent's transcript reaches past Herdr's own scrollback; ask for all of it.
    const frame = await this.frame(pane, (facts) =>
      Math.min(
        pane.agent && idle(pane.agentStatus) ? this.historyLines : facts.history,
        this.historyLines,
      ),
    );
    const screen = screenRows(frame.visible, frame.facts.viewportRows);
    const cursor = cursorAt(frame.visible, pane.cols);
    const rows = [...frame.above.map(lineAnsi), ...screen];
    const reason =
      pane.agent && idle(pane.agentStatus) && !this.shown?.idle ? "herdr-idle" : this.seedReason;
    this.lastSeedReason = reason;
    this.seedReason = "refresh";
    this.seedWanted = false;
    this.generation++;
    this.shown = {
      cols: pane.cols,
      rows: frame.facts.viewportRows,
      history: frame.facts.history,
      screen,
      cursor,
      idle: idle(pane.agentStatus),
      revision: frame.facts.revision,
    };
    const nativeHistory = this.history.capture(
      pane,
      frame,
      `${VT_CONTINUATION_PREAMBLE}${rows.join("\r\n")}${cursor}`,
    );
    this.emit("seed", {
      generation: this.generation,
      cols: pane.cols,
      rows: frame.facts.viewportRows,
      data: `\x1bc${rows.join("\r\n")}${cursor}`,
      ...(nativeHistory ? { nativeHistory } : {}),
      continuation: {
        data: `${VT_CONTINUATION_PREAMBLE}${screen.join("\r\n")}${cursor}`,
        reason,
      },
    });
  }

  private async poll(): Promise<void> {
    const shown = this.shown;
    const pane = this.current();
    if (!shown || pane.cols !== shown.cols) {
      this.seedReason = "resize";
      this.seedWanted = true;
      return;
    }
    const nowIdle = idle(pane.agentStatus);
    if (pane.agent && nowIdle && !shown.idle) {
      // The agent finished; its transcript now includes the latest turn.
      this.seedWanted = true;
      this.seedReason = "herdr-idle";
      return;
    }
    shown.idle = nowIdle;
    let reseed = false;
    const frame = await this.frame(pane, (facts) => {
      const added = facts.history - shown.history;
      // Scrollback was cleared, or more scrolled off than one read returns.
      reseed = added < 0 || added + facts.viewportRows > HERDR_READ_LINES;
      return reseed ? 0 : added;
    });
    // A blank screen gives the rows above nothing to be anchored to.
    if (
      reseed ||
      frame.facts.viewportRows !== shown.rows ||
      frame.above.length !== frame.facts.history - shown.history
    ) {
      this.seedReason = frame.facts.viewportRows !== shown.rows ? "resize" : "source-gap";
      this.seedWanted = true;
      return;
    }
    const scrolled = frame.above;
    const screen = screenRows(frame.visible, frame.facts.viewportRows);
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
    shown.revision = frame.facts.revision;
    shown.screen = screen;
    shown.cursor = cursor;
    if (data) this.emit("bytes", new TextEncoder().encode(data), this.generation);
  }

  private end(reason: VtSourceEnd | undefined): void {
    if (this.ended) return;
    this.ended = true;
    this.history.close();
    ++this.wakeSeq;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    if (reason) this.emit("end", reason);
  }

  private async probe(): Promise<{ generation: number; quiescent: boolean }> {
    const generation = this.generation;
    const frame = await this.frame(this.current(), () => 0);
    return {
      generation,
      quiescent:
        !this.ended &&
        !this.seedWanted &&
        generation === this.generation &&
        frame.facts.revision === this.shown?.revision &&
        frame.facts.viewportRows === this.shown.rows,
    };
  }
}

function idle(status: AgentState): boolean {
  return status === "idle" || status === "done";
}

function sameFacts(a: HerdrVtHistoryFacts, b: HerdrVtHistoryFacts): boolean {
  return (
    a.revision === b.revision &&
    a.history === b.history &&
    a.viewportRows === b.viewportRows &&
    a.offset === b.offset &&
    a.source?.agent === b.source?.agent &&
    a.source?.displayAgent === b.source?.displayAgent &&
    a.source?.status === b.source?.status
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
