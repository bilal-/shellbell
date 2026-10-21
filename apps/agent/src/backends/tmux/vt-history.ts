import { parseSgrRows, STREAM_LIMITS } from "@shellbell/protocol";
import { assertHistoryReadRequest } from "../history.js";
import type { HistoryCapture, HistoryReadRequest, HistoryReadResult, VtSeed } from "../types.js";
import type { TmuxControl } from "./control.js";
import { type HistoryDisplay, parseHistoryDisplay, Q_HISTORY_DISPLAY } from "./parse.js";

interface Evidence {
  capture: HistoryCapture;
  epoch: number;
  facts: HistoryDisplay;
}

/**
 * Native evidence from the SAME control checkpoint as a raw seed. The first implementation
 * deliberately requires a quiescent capture: any pane output retires it, even before history
 * saturates. This also catches reset-and-regrow between reads, which equal counts cannot prove.
 * A future growth-aware implementation must establish those intervening row identities.
 */
export class TmuxVtHistory {
  private enabled = false;
  private epoch = 0;
  private outputSeq = 0;
  private evidence: Evidence | null = null;
  private busy = false;
  private closed = false;
  private seedRevision = 0;

  get revision(): number {
    return this.seedRevision;
  }

  constructor(
    private readonly control: TmuxControl,
    private readonly pane: string,
  ) {
    if (!/^%\d+$/.test(pane)) throw new Error("invalid tmux pane id");
  }

  enable(): void {
    this.enabled = true;
  }

  /** Also includes other panes: queued output can obscure this pane's checkpoint boundary. */
  output(sequence: number): void {
    this.outputSeq = Math.max(this.outputSeq, sequence);
    this.retire();
  }

  invalidate(): void {
    this.seedRevision++;
    this.retire();
  }

  private retire(): void {
    this.epoch++;
    this.evidence = null;
  }

  close(): void {
    this.closed = true;
    this.invalidate();
  }

  /** Extra replies are captured atomically after the five ordinary seed commands. */
  commands(historyLines: number | undefined): string[] {
    if (!this.enabled || this.closed) return [];
    const start = `-${Math.min(historyLines ?? 2000, 2000)}`;
    return [
      `display -p -t ${this.pane} ${Q_HISTORY_DISPLAY}`,
      `capture-pane -p -e -N -S ${start} -E -1 -t ${this.pane}`,
    ];
  }

  capture(
    replies: string[][],
    seed: Pick<VtSeed, "cols" | "rows">,
    historyLines: number | undefined,
    checkpointSequence: number,
    replay: string,
    revision: number,
  ): VtSeed["nativeHistory"] {
    this.evidence = null;
    if (
      !this.enabled ||
      this.closed ||
      !this.control.alive ||
      revision !== this.seedRevision ||
      this.outputSeq > checkpointSequence
    )
      return undefined;
    const facts = parseHistoryDisplay(replies[5]?.[0] ?? "");
    if (!facts || facts.width !== seed.cols || facts.height !== seed.rows) return undefined;
    const count = Math.min(facts.historySize, historyLines ?? facts.historySize);
    // Keep the private proof bounded even for callers that request all native history.
    if (
      count > 2000 ||
      (count > 0 && replies[6]?.length !== count) ||
      Buffer.byteLength(replay) > STREAM_LIMITS.screenBytes ||
      (replies[6]?.reduce((size, row) => size + Buffer.byteLength(row), 0) ?? 0) >
        STREAM_LIMITS.screenBytes
    )
      return undefined;
    const lines = count === 0 ? [] : parseSgrRows(replies[6]!);
    // capture-pane expands tabs using its capture syntax, while seed replay uses the pane's
    // current tab stops. Do not offer proof for a row whose physical cells we cannot identify.
    if (replies[6]?.some((row) => row.includes("\t"))) return undefined;
    const capture: HistoryCapture = Object.freeze({});
    this.evidence = { capture, epoch: this.epoch, facts };
    return { capture, from: facts.historySize - count, to: facts.historySize, lines, replay };
  }

  async read(request: HistoryReadRequest): Promise<HistoryReadResult> {
    assertHistoryReadRequest(request);
    if (request.signal.aborted) return { status: "cancelled" };
    const evidence = this.evidence;
    if (!evidence || request.capture !== evidence.capture)
      return { status: "unavailable", reason: "unanchored" };
    if (request.reported !== evidence.facts.historySize)
      return { status: "unavailable", reason: "unanchored" };
    if (this.busy) return { status: "unavailable", reason: "busy" };
    this.busy = true;
    try {
      const from = Math.max(0, request.before - request.count);
      if (from - request.reported < -2_147_483_648)
        return { status: "unavailable", reason: "fetch-window" };
      const display = `display -p -t ${this.pane} ${Q_HISTORY_DISPLAY}`;
      const commands = [display];
      if (request.before > 0)
        commands.push(
          `capture-pane -p -e -N -S ${from - request.reported} -E ${request.before - 1 - request.reported} -t ${this.pane}`,
        );
      commands.push(display);
      const { replies } = await this.control.checkpoint(commands);
      if (request.signal.aborted) return { status: "cancelled" };
      if (!this.owns(evidence)) return { status: "reset" };
      const before = parseHistoryDisplay(replies[0]?.[0] ?? "");
      const after = parseHistoryDisplay(replies.at(-1)?.[0] ?? "");
      if (!sameFacts(before, evidence.facts) || !sameFacts(after, evidence.facts)) {
        this.invalidate();
        return { status: "reset" };
      }
      if (request.before === 0) return { status: "boundary", reason: "end", oldestAvailable: 0 };
      const rows = replies[1]!;
      if (rows.length !== request.before - from || rows.some((row) => row.includes("\t")))
        return { status: "unavailable", reason: "unanchored" };
      return {
        status: "page",
        from,
        to: request.before,
        oldestAvailable: 0,
        lines: parseSgrRows(rows),
      };
    } catch {
      if (request.signal.aborted) return { status: "cancelled" };
      if (this.evidence === evidence) this.invalidate();
      return { status: "reset" };
    } finally {
      // Cancellation does not release the physical command admission until it settles.
      this.busy = false;
    }
  }

  private owns(evidence: Evidence): boolean {
    return (
      !this.closed &&
      this.control.alive &&
      this.evidence === evidence &&
      evidence.epoch === this.epoch
    );
  }
}

function sameFacts(a: HistoryDisplay | null, b: HistoryDisplay): boolean {
  return (
    a !== null &&
    a.cursorX === b.cursorX &&
    a.cursorY === b.cursorY &&
    a.historySize === b.historySize &&
    a.width === b.width &&
    a.height === b.height &&
    a.historyLimit === b.historyLimit &&
    a.alternate === b.alternate
  );
}
