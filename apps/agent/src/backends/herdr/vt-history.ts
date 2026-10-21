import { type Line, STREAM_LIMITS } from "@shellbell/protocol";
import { assertHistoryReadRequest } from "../history.js";
import type {
  AgentState,
  HistoryCapture,
  HistoryReadRequest,
  HistoryReadResult,
  VtSeed,
} from "../types.js";
import { alignRecentHistory, type HerdrHistoryFacts, parseHistoryFacts } from "./history.js";
import type { HerdrVtPane } from "./vt-source.js";

interface Options {
  request: <T>(method: string, params: Record<string, unknown>) => Promise<T>;
  pane: () => HerdrVtPane | undefined;
}
interface Evidence {
  capture: HistoryCapture;
  pane: HerdrVtPane;
  facts: HerdrVtHistoryFacts;
  visible: readonly Line[];
}
export interface HerdrVtHistoryFacts extends HerdrHistoryFacts {
  readonly source?: {
    readonly agent: string | null;
    readonly displayAgent: string | null;
    readonly status: AgentState;
  };
}

/** Native status is authoritative; the event-fed pane cache may still describe the last turn. */
export function nativeHistorySource(value: unknown): HerdrVtHistoryFacts["source"] {
  if (typeof value !== "object" || value === null || !("pane" in value)) return undefined;
  const pane = value.pane;
  if (typeof pane !== "object" || pane === null || !("agent_status" in pane)) return undefined;
  const status = pane.agent_status;
  if (
    typeof status !== "string" ||
    !["idle", "working", "blocked", "done", "unknown"].includes(status)
  )
    return undefined;
  const agent = "agent" in pane ? pane.agent : null;
  const displayAgent = "display_agent" in pane ? pane.display_agent : null;
  if (
    (agent != null && typeof agent !== "string") ||
    (displayAgent != null && typeof displayAgent !== "string")
  )
    return undefined;
  return { agent: agent || null, displayAgent: displayAgent || null, status: status as AgentState };
}

/** A raw seed and its older rows share one checked pane revision and physical visible suffix. */
export class HerdrVtHistory {
  private enabled = false;
  private closed = false;
  private busy = false;
  private evidence: Evidence | null = null;

  constructor(private readonly options: Options) {}

  enable(): void {
    this.enabled = true;
  }
  invalidate(): void {
    this.evidence = null;
  }
  close(): void {
    this.closed = true;
    this.invalidate();
  }

  observe(pane: HerdrVtPane, facts: HerdrVtHistoryFacts): void {
    const evidence = this.evidence;
    if (evidence && (!samePane(pane, evidence.pane) || !sameFacts(facts, evidence.facts)))
      this.invalidate();
  }

  capture(
    pane: HerdrVtPane,
    frame: { facts: HerdrVtHistoryFacts; above: readonly Line[]; visible: readonly Line[] },
    replay: string,
  ): VtSeed["nativeHistory"] {
    this.invalidate();
    const { facts, above, visible } = frame;
    // An idle agent's recent rows may be its transcript, outside the PTY's native history.
    if (
      !this.enabled ||
      this.closed ||
      !samePane(this.options.pane(), pane) ||
      (pane.agent && (pane.agentStatus === "idle" || pane.agentStatus === "done")) ||
      !facts.source ||
      ((facts.source.agent !== null || facts.source.displayAgent !== null) &&
        (facts.source.status === "idle" || facts.source.status === "done")) ||
      facts.paneId !== pane.paneId ||
      facts.terminalId !== pane.terminalId ||
      facts.offset !== 0 ||
      facts.viewportRows !== pane.rows ||
      above.length > facts.history ||
      above.length + visible.length > 1000 ||
      (facts.history > 0 && visible.length === 0) ||
      Buffer.byteLength(replay) > STREAM_LIMITS.screenBytes
    )
      return undefined;
    const capture: HistoryCapture = Object.freeze({});
    this.evidence = {
      capture,
      pane: { ...pane },
      facts: { ...facts, source: { ...facts.source } },
      visible,
    };
    return { capture, from: facts.history - above.length, to: facts.history, lines: above, replay };
  }

  async read(request: HistoryReadRequest): Promise<HistoryReadResult> {
    assertHistoryReadRequest(request);
    if (request.signal.aborted) return { status: "cancelled" };
    const evidence = this.evidence;
    if (
      !evidence ||
      request.capture !== evidence.capture ||
      request.reported !== evidence.facts.history
    )
      return { status: "unavailable", reason: "unanchored" };
    if (!this.owns(evidence)) return { status: "reset" };
    if (this.busy) return { status: "unavailable", reason: "busy" };
    this.busy = true;
    const stopped = (): HistoryReadResult | undefined =>
      request.signal.aborted
        ? { status: "cancelled" }
        : !this.owns(evidence)
          ? { status: "reset" }
          : undefined;
    try {
      if (!(await this.confirm(evidence))) return stopped() ?? { status: "reset" };
      const firstStop = stopped();
      if (firstStop) return firstStop;
      let candidate: HistoryReadResult;
      if (request.before === 0)
        candidate = { status: "boundary", reason: "end", oldestAvailable: 0 };
      else {
        const from = Math.max(0, request.before - request.count);
        const oldestReadable = Math.max(0, request.reported + evidence.visible.length - 1000);
        if (request.before <= oldestReadable)
          return { status: "unavailable", reason: "fetch-window" };
        const want = Math.min(1000, evidence.facts.viewportRows + request.reported - from);
        const result = await this.options.request("pane.read", {
          pane_id: evidence.pane.paneId,
          source: "recent",
          format: "ansi",
          lines: want,
        });
        const readStop = stopped();
        if (readStop) return readStop;
        const aligned = alignRecentHistory(result, {
          paneId: evidence.pane.paneId,
          cols: evidence.pane.cols,
          viewportRows: evidence.facts.viewportRows,
          historyRows: evidence.facts.history,
          requestedRows: want,
          visible: evidence.visible,
        });
        if (!aligned) return { status: "unavailable", reason: "changed" };
        const start = Math.max(from, aligned.from);
        if (start >= request.before) return { status: "unavailable", reason: "fetch-window" };
        candidate = {
          status: "page",
          from: start,
          to: request.before,
          // Native retention and the API's fetch window are separate. Reporting the window
          // as an oldest row would falsely call it complete; a later read returns fetch-window.
          oldestAvailable: 0,
          lines: aligned.lines.slice(start - aligned.from, request.before - aligned.from),
        };
      }
      if (!(await this.confirm(evidence))) return stopped() ?? { status: "reset" };
      return stopped() ?? candidate;
    } catch {
      if (this.evidence === evidence) this.invalidate();
      return stopped() ?? { status: "reset" };
    } finally {
      this.busy = false;
    }
  }

  private owns(evidence: Evidence): boolean {
    return (
      !this.closed && this.evidence === evidence && samePane(this.options.pane(), evidence.pane)
    );
  }

  private async confirm(evidence: Evidence): Promise<boolean> {
    const result = await this.options.request("pane.get", { pane_id: evidence.pane.paneId });
    const parsed = parseHistoryFacts(result, evidence.pane.paneId, evidence.pane.terminalId);
    const facts = parsed ? { ...parsed, source: nativeHistorySource(result) } : null;
    if (!facts || !sameFacts(facts, evidence.facts)) {
      // A later generation may have arrived while this old read was in flight.
      if (this.evidence === evidence) this.invalidate();
      return false;
    }
    return true;
  }
}

function samePane(a: HerdrVtPane | undefined, b: HerdrVtPane): boolean {
  return (
    !!a &&
    a.paneId === b.paneId &&
    a.terminalId === b.terminalId &&
    a.cols === b.cols &&
    a.rows === b.rows &&
    a.agent === b.agent &&
    a.agentStatus === b.agentStatus
  );
}
function sameFacts(a: HerdrVtHistoryFacts, b: HerdrVtHistoryFacts): boolean {
  return (
    a.paneId === b.paneId &&
    a.terminalId === b.terminalId &&
    a.revision === b.revision &&
    a.history === b.history &&
    a.offset === b.offset &&
    a.viewportRows === b.viewportRows &&
    a.source?.agent === b.source?.agent &&
    a.source?.displayAgent === b.source?.displayAgent &&
    a.source?.status === b.source?.status
  );
}
