import { type VtHistoryHeader, VtReplayLog } from "./vt-replay-log";
import {
  decodeVtBytes,
  encodeVtBytes,
  type TerminalVtMessage,
  VT_MESSAGE_BYTES,
  type VtRenderError,
} from "./vt-wire";

export interface LegacyVtSource {
  readonly generation: number;
  readonly cols: number;
  readonly rows: number;
  readonly seed: Uint8Array;
  readonly chunks: readonly Uint8Array[];
}
export type VtSource = LegacyVtSource | VtReplayLog;
export interface VtPendingOperation {
  document: string;
  sequence: number;
  epoch: number;
}
interface Flight {
  source: VtSource;
  epoch: number;
  sequence: number;
  kind: "capture" | "restore" | "history" | "seed" | "tail" | "legacy";
  applied?: number;
  completeSeed?: boolean;
}

/** One admitted WebView operation at a time, including across source changes. */
export class TerminalVtBridge {
  private document: string | null = null;
  private source: VtSource | null = null;
  private sequence = 0;
  private epoch = 0;
  private flight: Flight | null = null;
  private failed = false;
  private materialized = false;
  private materializedScope: object | undefined;
  private restoreFailures: { source: VtReplayLog; count: number } | null = null;
  private phase: "start" | "history" | "seed" | "tail" = "start";
  private historyAt = 0;
  private seedAt = 0;
  private tailAt = 0;
  private legacyChunk = 0;
  private legacyAt = 0;

  constructor(
    private readonly send: (message: TerminalVtMessage) => void,
    private readonly onFailure: (source: VtSource, reason: VtRenderError) => void = () => {},
    private readonly onReady: (source: VtSource) => void = () => {},
  ) {}

  ready(document: string): void {
    this.document = document;
    this.sequence = 0;
    this.flight = null;
    this.materialized = false;
    if (this.source instanceof VtReplayLog) this.source.beginRender();
    this.restart();
    this.pump();
  }
  /** A replaced document or an actual switch to snapshots owns no raw parser. */
  detach(): void {
    if (this.source instanceof VtReplayLog) this.source.beginRender();
    this.document = null;
    this.flight = null;
    this.materialized = false;
    this.restart();
  }
  present(source: VtSource | null): void {
    if (source !== this.source) {
      this.restoreFailures = null;
      this.source = source;
      if (source instanceof VtReplayLog) source.beginRender();
      this.restart();
    }
    if (!source) this.materialized = false;
    this.pump();
  }
  replay(): void {
    if (this.source instanceof VtReplayLog) this.source.beginRender();
    this.restart();
    this.pump();
  }

  acceptsStatus(document: string, epoch: unknown, source: VtSource | null = this.source): boolean {
    return (
      document === this.document &&
      source === this.source &&
      epoch === this.epoch &&
      !this.failed &&
      this.source !== null &&
      !(this.source instanceof VtReplayLog && this.source.isDisposed)
    );
  }
  get pendingOperation(): VtPendingOperation | null {
    return this.flight && this.document
      ? { document: this.document, sequence: this.flight.sequence, epoch: this.flight.epoch }
      : null;
  }
  timeout(operation: VtPendingOperation): void {
    if (!this.match(operation.document, operation.sequence, operation.epoch)) return;
    // A timed-out parser may still be running. Do not send another operation
    // into it: only a fresh document or an acknowledged raw-mode switch can resume.
    this.document = null;
    this.materialized = false;
    this.flight = null;
    this.fail("renderer");
  }

  acknowledge(document: string, sequence: number, epoch: unknown): void {
    const flight = this.match(document, sequence, epoch);
    if (!flight) return;
    this.flight = null;
    if (flight.completeSeed && flight.source instanceof VtReplayLog) {
      this.materialized = true;
      this.materializedScope = flight.source.owner?.scope;
    }
    if (
      flight.source === this.source &&
      flight.epoch === this.epoch &&
      flight.source instanceof VtReplayLog &&
      !flight.source.isDisposed
    ) {
      if (flight.kind === "capture" && flight.source.history === null) {
        this.fail("checkpoint-missing");
        return;
      }
      if (flight.applied !== undefined && !flight.source.render(flight.applied)) {
        this.fail("invalid-transfer");
        return;
      }
      if (!flight.source.isRestoring) this.restoreFailures = null;
    }
    if (
      flight.completeSeed &&
      flight.source === this.source &&
      flight.epoch === this.epoch &&
      !(flight.source instanceof VtReplayLog && flight.source.isDisposed)
    )
      this.onReady(flight.source);
    this.pump();
  }

  reject(document: string, sequence: unknown, epoch: unknown, reason: unknown): void {
    if (typeof sequence !== "number") return;
    const flight = this.match(document, sequence, epoch);
    if (!flight) return;
    this.flight = null;
    this.materialized = false;
    if (flight.source !== this.source || flight.epoch !== this.epoch) {
      this.pump();
      return;
    }
    if (
      reason === "renderer" &&
      flight.source instanceof VtReplayLog &&
      flight.source.isRestoring
    ) {
      const count =
        this.restoreFailures?.source === flight.source ? this.restoreFailures.count + 1 : 1;
      this.restoreFailures = { source: flight.source, count };
      if (count >= 2) reason = "checkpoint-missing";
    }
    this.fail(
      reason === "checkpoint-missing" || reason === "renderer" ? reason : "invalid-transfer",
    );
  }

  /** Returns true for history messages, including stale ones deliberately ignored. */
  receiveHistory(value: unknown): boolean {
    if (!value || typeof value !== "object") return false;
    const message = value as Record<string, unknown>;
    if (!["vt-history-start", "vt-history-part", "vt-history-end"].includes(String(message.type)))
      return false;
    const flight =
      typeof message.document === "string" && typeof message.sequence === "number"
        ? this.match(message.document, message.sequence, message.epoch)
        : null;
    if (!flight || flight.source !== this.source || flight.epoch !== this.epoch || this.failed)
      return true;
    const source = flight.source;
    if (source instanceof VtReplayLog && source.isDisposed) return true;
    if (!(source instanceof VtReplayLog) || flight.kind !== "capture") {
      this.fail("invalid-transfer");
      return true;
    }
    let valid = false;
    try {
      if (message.type === "vt-history-start")
        valid = Boolean(
          message.history &&
            typeof message.history === "object" &&
            source.beginHistory(message.history as VtHistoryHeader),
        );
      else if (message.type === "vt-history-part")
        valid =
          typeof message.offset === "number" &&
          typeof message.data === "string" &&
          source.historyPart(message.offset, decodeVtBytes(message.data));
      else valid = source.commitHistory();
    } catch {
      valid = false;
    }
    if (!valid) this.fail("invalid-transfer");
    return true;
  }

  private match(document: string, sequence: number, epoch: unknown): Flight | null {
    const flight = this.flight;
    return flight &&
      document === this.document &&
      sequence === flight.sequence &&
      epoch === flight.epoch
      ? flight
      : null;
  }
  private restart(): void {
    this.epoch++;
    this.failed = false;
    this.phase = "start";
    this.historyAt = this.seedAt = this.tailAt = this.legacyAt = this.legacyChunk = 0;
  }
  private fail(reason: VtRenderError): void {
    if (
      this.failed ||
      !this.source ||
      (this.source instanceof VtReplayLog && this.source.isDisposed)
    )
      return;
    this.failed = true;
    this.flight = null;
    this.onFailure(this.source, reason);
  }
  private emit(
    source: VtSource,
    data: Uint8Array,
    kind: Flight["kind"],
    options: Pick<TerminalVtMessage, "checkpoint" | "reset"> = {},
    progress: Pick<Flight, "applied" | "completeSeed"> = {},
  ): void {
    const sequence = ++this.sequence;
    this.flight = { source, epoch: this.epoch, sequence, kind, ...progress };
    this.send({
      document: this.document!,
      epoch: this.epoch,
      sequence,
      data: encodeVtBytes(data),
      ...options,
    });
  }
  private pump(): void {
    const source = this.source;
    if (
      !this.document ||
      !source ||
      this.flight ||
      this.failed ||
      (source instanceof VtReplayLog && source.isDisposed)
    )
      return;
    if (!(source instanceof VtReplayLog)) {
      this.legacy(source);
      return;
    }
    if (this.phase === "start") {
      const history = source.history;
      if (!history) {
        if (!this.materialized || this.materializedScope !== source.owner?.scope) {
          this.fail("checkpoint-missing");
          return;
        }
        this.phase = "seed";
        this.materialized = false;
        this.emit(source, new Uint8Array(), "capture", {
          checkpoint: { kind: "capture", cols: source.cols, rows: source.rows },
        });
      } else {
        this.phase = history.data.length > 0 ? "history" : "seed";
        this.materialized = false;
        this.emit(source, new Uint8Array(), "restore", {
          checkpoint: {
            kind: "restore",
            cols: source.cols,
            rows: source.rows,
            history: { bytes: history.data.length, rows: history.rows, dropped: history.dropped },
          },
        });
      }
      return;
    }
    if (this.phase === "history") {
      const data = source.history!.data;
      const offset = this.historyAt;
      const part = data.subarray(offset, offset + VT_MESSAGE_BYTES);
      this.historyAt += part.length;
      if (this.historyAt === data.length) this.phase = "seed";
      this.emit(source, part, "history", { checkpoint: { kind: "history", offset } });
      return;
    }
    if (this.phase === "seed") {
      const part = source.seed.subarray(this.seedAt, this.seedAt + VT_MESSAGE_BYTES);
      this.seedAt += part.length;
      const complete = this.seedAt === source.seed.length;
      if (complete) this.phase = "tail";
      this.emit(
        source,
        part,
        "seed",
        { checkpoint: { kind: "seed", complete } },
        complete ? { applied: 0, completeSeed: true } : {},
      );
      return;
    }
    const part = source.read(this.tailAt, VT_MESSAGE_BYTES);
    if (!part) return;
    this.tailAt += part.length;
    this.emit(source, part, "tail", { checkpoint: { kind: "tail" } }, { applied: this.tailAt });
  }
  private legacy(source: LegacyVtSource): void {
    if (this.phase === "start" || this.phase === "seed") {
      const first = this.phase === "start";
      this.materialized = false;
      const part = source.seed.subarray(this.seedAt, this.seedAt + VT_MESSAGE_BYTES);
      this.seedAt += part.length;
      this.phase = this.seedAt === source.seed.length ? "tail" : "seed";
      this.emit(
        source,
        part,
        "legacy",
        first ? { reset: { cols: source.cols, rows: source.rows } } : {},
        { completeSeed: this.phase === "tail" },
      );
      return;
    }
    const data = source.chunks[this.legacyChunk];
    if (!data) return;
    const part = data.subarray(this.legacyAt, this.legacyAt + VT_MESSAGE_BYTES);
    this.legacyAt += part.length;
    if (this.legacyAt === data.length) {
      this.legacyChunk++;
      this.legacyAt = 0;
    }
    this.emit(source, part, "legacy");
  }
}
