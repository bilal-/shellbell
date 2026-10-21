import { STREAM_LIMITS } from "@shellbell/protocol";
import { TERMINAL_BUFFER_LIMIT } from "./buffer";
import {
  type CheckpointTerminal,
  checkpointVtHistory,
  type HistorySerializer,
  restoreVtHistory,
  VT_HISTORY_BYTES,
  writeVt,
} from "./vt-checkpoint";
import type { VtHistoryHeader } from "./vt-replay-log";
import {
  decodeVtBytes,
  encodeVtBytes,
  type TerminalVtMessage,
  VT_MESSAGE_BYTES,
  type VtRenderError,
  type VtRendererEvent,
} from "./vt-wire";

interface RenderTerminal extends CheckpointTerminal {
  scrollToLine(line: number): void;
  readonly buffer: CheckpointTerminal["buffer"] & {
    readonly active: { readonly type: string; readonly viewportY: number; readonly baseY: number };
  };
}
interface RestoreStage {
  cols: number;
  rows: number;
  history: VtHistoryHeader;
  data: Uint8Array;
  received: number;
}
class RenderFailure extends Error {
  constructor(readonly reason: VtRenderError) {
    super(reason);
  }
}
const emptyHistory = () => ({ data: new Uint8Array(), rows: 0, dropped: false });
const geometry = (cols: number, rows: number) =>
  Number.isSafeInteger(cols) &&
  cols >= 1 &&
  cols <= STREAM_LIMITS.cols &&
  Number.isSafeInteger(rows) &&
  rows >= 1 &&
  rows <= STREAM_LIMITS.rows;

/** Serialized parser operations inside one WebView; never treats a partial restore as a live seed. */
export class VtRenderer {
  private sequence = 0;
  private epoch: number | null = null;
  private version = 0;
  private pending: Promise<void> | null = null;
  private mode: "empty" | "legacy" | "history" | "seed" | "live" = "empty";
  private stage: RestoreStage | null = null;
  private dropped = false;
  private replacing = false;
  private first: ReturnType<CheckpointTerminal["registerMarker"]>;
  private reader: ReturnType<CheckpointTerminal["registerMarker"]>;

  constructor(
    private readonly term: RenderTerminal,
    private readonly serializer: HistorySerializer,
    private readonly document: string,
    private readonly post: (event: VtRendererEvent) => void,
    private readonly beforeRebuild: () => void = () => {},
  ) {}

  get rebuilding(): boolean {
    return this.replacing || (this.mode !== "live" && this.mode !== "legacy");
  }
  get statusReady(): boolean {
    return !this.pending && (this.mode === "live" || this.mode === "legacy");
  }
  get renderEpoch(): number {
    return this.epoch ?? 0;
  }
  get historyDropped(): boolean {
    return this.dropped;
  }
  get historyLimited(): boolean {
    return this.dropped || this.term.buffer.normal.baseY >= TERMINAL_BUFFER_LIMIT;
  }

  /** Drain parser work before switching to snapshots; suppress every late operation's reply. */
  async reset(): Promise<void> {
    this.version++;
    const pending = this.pending;
    if (pending) await pending.catch(() => {});
    this.pending = null;
    this.sequence = 0;
    this.epoch = null;
    this.mode = "empty";
    this.replacing = false;
    this.stage = null;
    this.dropped = false;
    this.clearMarker();
    this.clearReader();
  }

  async receive(message: TerminalVtMessage): Promise<boolean> {
    if (message.document !== this.document) return false;
    const epoch = message.epoch ?? 0;
    const reply = { document: this.document, epoch, sequence: message.sequence };
    if (
      this.pending ||
      !Number.isSafeInteger(epoch) ||
      epoch < 0 ||
      !Number.isSafeInteger(message.sequence) ||
      message.sequence !== this.sequence + 1
    ) {
      this.post({ ...reply, type: "vt-error", reason: "invalid-transfer" });
      return false;
    }
    this.sequence = message.sequence;
    const version = this.version;
    const active = () => version === this.version;
    const task = this.perform(message, epoch, active);
    this.pending = task;
    try {
      await task;
      if (!active()) return false;
      this.pending = null;
      this.post({ ...reply, type: "vt-ack" });
      return true;
    } catch (error) {
      if (active()) {
        this.mode = "empty";
        this.replacing = false;
        this.stage = null;
        this.clearMarker();
        this.clearReader();
        this.post({
          ...reply,
          type: "vt-error",
          reason: error instanceof RenderFailure ? error.reason : "renderer",
        });
      }
      return false;
    } finally {
      if (this.pending === task) this.pending = null;
    }
  }

  private async perform(
    message: TerminalVtMessage,
    epoch: number,
    active: () => boolean,
  ): Promise<void> {
    let bytes: Uint8Array;
    try {
      bytes = decodeVtBytes(message.data);
    } catch {
      throw new RenderFailure("invalid-transfer");
    }
    const command = message.checkpoint;
    if (message.reset && command) throw new RenderFailure("invalid-transfer");
    const starts =
      Boolean(message.reset) || command?.kind === "capture" || command?.kind === "restore";
    if (!starts && this.epoch !== epoch) throw new RenderFailure("invalid-transfer");
    if (starts) this.epoch = epoch;
    if (!command) {
      if (message.reset) {
        if (!geometry(message.reset.cols, message.reset.rows))
          throw new RenderFailure("invalid-transfer");
        this.clearMarker();
        this.stage = null;
        this.dropped = false;
        this.mode = "legacy";
        this.replacing = true;
        this.clearReader();
        this.beforeRebuild();
        await restoreVtHistory(this.term, emptyHistory(), message.reset.cols, message.reset.rows);
        if (!active()) return;
      } else if (this.mode !== "legacy") throw new RenderFailure("invalid-transfer");
      await writeVt(this.term, bytes);
      if (active()) this.replacing = false;
      return;
    }
    switch (command.kind) {
      case "capture": {
        if (!geometry(command.cols, command.rows) || bytes.length !== 0)
          throw new RenderFailure("invalid-transfer");
        if (this.mode !== "live") throw new RenderFailure("checkpoint-missing");
        const buffer = this.term.buffer.active;
        const readingPosition =
          buffer.type === "normal" && buffer.viewportY < buffer.baseY
            ? { row: buffer.viewportY }
            : undefined;
        this.observeEviction();
        this.clearMarker();
        this.clearReader();
        this.mode = "seed";
        this.stage = null;
        this.beforeRebuild();
        const history = await checkpointVtHistory(
          this.term,
          this.serializer,
          command.cols,
          command.rows,
          VT_HISTORY_BYTES,
          readingPosition,
        );
        if (!active()) return;
        if (readingPosition)
          this.reader = this.term.registerMarker(
            readingPosition.row - this.term.buffer.normal.baseY - this.term.buffer.normal.cursorY,
          );
        this.dropped ||= history.dropped;
        const common = { document: this.document, epoch, sequence: message.sequence };
        this.post({
          ...common,
          type: "vt-history-start",
          history: {
            bytes: history.data.byteLength,
            rows: history.rows,
            dropped: this.dropped,
          },
        });
        for (let at = 0; at < history.data.length; at += VT_MESSAGE_BYTES) {
          if (!active()) return;
          this.post({
            ...common,
            type: "vt-history-part",
            offset: at,
            data: encodeVtBytes(history.data.subarray(at, at + VT_MESSAGE_BYTES)),
          });
        }
        if (active()) this.post({ ...common, type: "vt-history-end" });
        return;
      }
      case "restore": {
        const history = command.history;
        if (
          !geometry(command.cols, command.rows) ||
          bytes.length !== 0 ||
          !history ||
          !Number.isSafeInteger(history.bytes) ||
          history.bytes < 0 ||
          history.bytes > VT_HISTORY_BYTES ||
          !Number.isSafeInteger(history.rows) ||
          history.rows < 0 ||
          history.rows > TERMINAL_BUFFER_LIMIT ||
          typeof history.dropped !== "boolean" ||
          (history.rows === 0) !== (history.bytes === 0)
        )
          throw new RenderFailure("invalid-transfer");
        this.clearMarker();
        this.mode = "history";
        this.replacing = false;
        this.clearReader();
        this.beforeRebuild();
        this.dropped = history.dropped;
        this.stage = {
          cols: command.cols,
          rows: command.rows,
          history: { ...history },
          data: new Uint8Array(history.bytes),
          received: 0,
        };
        if (history.bytes === 0) await this.finishRestore(active);
        return;
      }
      case "history": {
        const stage = this.stage;
        if (
          this.mode !== "history" ||
          !stage ||
          command.offset !== stage.received ||
          bytes.length === 0 ||
          command.offset + bytes.length > stage.data.length
        )
          throw new RenderFailure("invalid-transfer");
        stage.data.set(bytes, command.offset);
        stage.received += bytes.length;
        if (stage.received === stage.data.length) await this.finishRestore(active);
        return;
      }
      case "seed":
        if (
          this.mode !== "seed" ||
          typeof command.complete !== "boolean" ||
          (!command.complete && bytes.length === 0)
        )
          throw new RenderFailure("invalid-transfer");
        await writeVt(this.term, bytes);
        if (active() && command.complete) {
          this.mode = "live";
          if (this.reader && this.term.buffer.active.type === "normal")
            this.term.scrollToLine(this.reader.isDisposed ? 0 : this.reader.line);
          this.clearReader();
          this.trackFirst();
        }
        return;
      case "tail":
        if (this.mode !== "live" || bytes.length === 0) throw new RenderFailure("invalid-transfer");
        this.trackFirst();
        await writeVt(this.term, bytes);
        if (active()) {
          this.observeEviction();
          this.trackFirst();
        }
        return;
      default:
        throw new RenderFailure("invalid-transfer");
    }
  }

  private async finishRestore(active: () => boolean): Promise<void> {
    const stage = this.stage!;
    await restoreVtHistory(
      this.term,
      { data: stage.data, rows: stage.history.rows, dropped: stage.history.dropped },
      stage.cols,
      stage.rows,
    );
    if (active()) {
      this.stage = null;
      this.mode = "seed";
    }
  }
  private clearReader(): void {
    this.reader?.dispose();
    this.reader = undefined;
  }
  private clearMarker(): void {
    this.first?.dispose();
    this.first = undefined;
  }
  private trackFirst(): void {
    if (this.first?.isDisposed) this.first = undefined;
    if (!this.first && this.term.buffer.active.type === "normal")
      this.first = this.term.registerMarker(
        -this.term.buffer.normal.baseY - this.term.buffer.normal.cursorY,
      );
  }
  private observeEviction(): void {
    // A program clearing its own screen is not evidence of a phone memory limit.
    if (this.first?.isDisposed && this.term.buffer.normal.baseY >= TERMINAL_BUFFER_LIMIT)
      this.dropped = true;
  }
}
