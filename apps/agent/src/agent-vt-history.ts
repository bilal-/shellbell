import {
  prepareStreamHistory,
  STREAM_LIMITS,
  type StreamChunk,
  type StreamMessage,
  type StreamSender,
} from "@shellbell/protocol";
import type { HistoryReadResult, VtSeed, VtSource } from "./backends/types.js";

interface Anchor {
  readonly capture: string;
  readonly generation: number;
  readonly native: NonNullable<VtSeed["nativeHistory"]>;
  before: number;
  applied: boolean;
}
interface Request {
  readonly id: string;
  readonly anchor: Anchor;
  readonly before: number;
  readonly count: number;
  readonly controller: AbortController;
  deadline: number | null;
  finalSequence: number | null;
  nextBefore: number | null;
  phase: "reading" | "transfer";
}
interface Options {
  subscriptionId: string;
  source: NonNullable<VtSource["history"]>;
  sender: StreamSender;
  now: () => number;
  ready: () => void;
  error: (message: StreamMessage) => void;
  invalid: () => void;
  stalled: () => void;
}

/** One bounded native read/page, sharing the terminal sender's credits and history lane. */
export class AgentVtHistory {
  private anchor: Anchor | null = null;
  private request: Request | null = null;
  /** A revoked or timed-out request keeps physical admission until its promise settles. */
  private reading: Request | null = null;
  private latestRequest: string | null = null;
  private open = true;

  constructor(private readonly options: Options) {}

  bind(capture: string, generation: number, native?: VtSeed["nativeHistory"]): void {
    this.retire();
    this.anchor = native
      ? { capture, generation, native, before: native.from, applied: false }
      : null;
  }

  retire(): void {
    this.request?.controller.abort();
    if (this.request?.phase === "reading") this.request = null;
    this.latestRequest = null;
    this.anchor = null;
  }

  applied(capture: string, generation: number): void {
    if (this.anchor?.capture === capture && this.anchor.generation === generation)
      this.anchor.applied = true;
  }

  receive(message: Extract<StreamMessage, { type: "stream.history.get" }>): void {
    if (
      !this.open ||
      this.request?.id === message.requestId ||
      this.latestRequest === message.requestId
    )
      return;
    const anchor = this.anchor;
    if (!anchor || message.capture !== anchor.capture || message.generation !== anchor.generation) {
      this.error(message.requestId, "history-reset");
      return;
    }
    if (
      !anchor.applied ||
      this.request ||
      this.reading ||
      !this.options.sender.canOffer("history")
    ) {
      this.error(message.requestId, "history-unavailable");
      return;
    }
    if (message.before !== anchor.before) {
      this.error(message.requestId, "history-reset");
      return;
    }
    const request: Request = {
      id: message.requestId,
      anchor,
      before: message.before,
      count: message.count,
      controller: new AbortController(),
      deadline: this.options.now() + STREAM_LIMITS.totalMs,
      finalSequence: null,
      nextBefore: null,
      phase: "reading",
    };
    this.request = this.reading = request;
    let reading: Promise<HistoryReadResult>;
    try {
      reading = this.options.source.read({
        capture: anchor.native.capture,
        reported: anchor.native.to,
        before: message.before,
        count: message.count,
        signal: request.controller.signal,
      });
    } catch {
      this.complete(request, { status: "unavailable", reason: "changed" });
      return;
    }
    void Promise.resolve(reading)
      .then(
        (result) => this.complete(request, result),
        () => this.complete(request, { status: "unavailable", reason: "changed" }),
      )
      .catch(() => {
        if (this.open) this.options.invalid();
      });
  }

  admit(chunk: StreamChunk): void {
    const request = this.request;
    if (request && chunk.meta.kind === "history" && chunk.meta.requestId === request.id) {
      request.deadline = null;
      if (chunk.index === chunk.count - 1) request.finalSequence = chunk.sequence;
    }
  }

  acknowledge(through: number): void {
    const request = this.request;
    if (!request || request.finalSequence === null || through < request.finalSequence) return;
    if (this.anchor === request.anchor) {
      if (request.nextBefore === null) this.anchor = null;
      else this.anchor.before = request.nextBefore;
    }
    this.finish(request);
  }

  tick(): void {
    const request = this.request;
    if (!request || request.deadline === null || this.options.now() < request.deadline) return;
    if (request.phase === "transfer") {
      this.options.stalled();
      return;
    }
    request.controller.abort();
    this.finish(request, "history-unavailable");
  }
  get deadline(): number | null {
    return this.request?.deadline ?? null;
  }

  close(): void {
    this.open = false;
    this.request?.controller.abort();
    this.reading?.controller.abort();
    this.request = null;
    this.anchor = null;
  }

  private complete(request: Request, result: HistoryReadResult): void {
    if (this.reading === request) this.reading = null;
    if (!this.open || this.request !== request || this.anchor !== request.anchor) return;
    this.tick();
    if (this.request !== request) return;
    if (result.status === "reset") {
      this.anchor = null;
      this.finish(request, "history-reset");
      return;
    }
    if (result.status === "unavailable" || result.status === "cancelled") {
      this.finish(
        request,
        "history-unavailable",
        result.status === "unavailable" && result.reason === "fetch-window"
          ? "fetch-window"
          : undefined,
      );
      return;
    }
    if (result.status !== "page" && result.status !== "boundary") {
      this.options.invalid();
      return;
    }
    if (
      result.status === "page" &&
      (!Array.isArray(result.lines) || result.lines.length > request.count)
    ) {
      this.options.invalid();
      return;
    }
    const meta = {
      kind: "history" as const,
      generation: request.anchor.generation,
      requestId: request.id,
      before: request.before,
    };
    const prepared = prepareStreamHistory({ ...result, ...meta });
    if (!prepared.ok) {
      if (prepared.code === "history-line-too-large") this.finish(request, prepared.code);
      else this.options.invalid();
      return;
    }
    const offered = this.options.sender.offer(
      { ...meta, capture: request.anchor.capture },
      prepared.bytes,
    );
    if (!offered.accepted) {
      this.options.invalid();
      return;
    }
    request.phase = "transfer";
    request.nextBefore = prepared.record.status === "page" ? prepared.record.nextBefore : null;
    // The sender owns transfer deadlines once its first chunk is admitted. A refused first
    // chunk must also remain bounded while the shared route is congested.
    request.deadline = this.options.now() + STREAM_LIMITS.progressMs;
    this.options.ready();
  }

  private finish(
    request: Request,
    error?: "history-unavailable" | "history-reset" | "history-line-too-large",
    historyReason?: "fetch-window",
  ): void {
    if (this.request !== request) return;
    this.request = null;
    this.latestRequest = request.id;
    request.deadline = null;
    if (error) this.error(request.id, error, historyReason);
  }

  private error(
    requestId: string,
    code: "history-unavailable" | "history-reset" | "history-line-too-large",
    historyReason?: "fetch-window",
  ): void {
    this.options.error({
      type: "stream.error",
      subscriptionId: this.options.subscriptionId,
      requestId,
      code,
      ...(historyReason ? { historyReason } : {}),
    });
  }
}
