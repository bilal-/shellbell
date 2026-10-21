import { nativeHistoryProof, STREAM_LIMITS } from "@shellbell/protocol";
import {
  type CheckpointTerminal,
  checkpointVtHistory,
  type HistorySerializer,
  restoreVtHistory,
  VT_HISTORY_BYTES,
  writeVt,
} from "./vt-checkpoint";
import { TERMINAL_BUFFER_LIMIT } from "./vt-limits";
import type { VtHistoryHeader } from "./vt-replay-log";
import {
  decodeVtBytes,
  encodeVtBytes,
  type TerminalVtMessage,
  VT_MESSAGE_BYTES,
  type VtRenderError,
  type VtRendererEvent,
} from "./vt-wire";

export interface RenderTerminal extends CheckpointTerminal {
  readonly parser?: {
    registerCsiHandler(
      id: { prefix?: string; final: string },
      handler: (params: (number | number[])[]) => boolean,
    ): { dispose(): void };
  };
  scrollToLine(line: number): void;
  readonly buffer: CheckpointTerminal["buffer"] & {
    readonly normal: {
      readonly baseY: number;
      readonly cursorY: number;
      getLine(index: number): { translateToString(trimRight?: boolean): string } | undefined;
    };
    readonly active: { readonly type: string; readonly viewportY: number; readonly baseY: number };
  };
}
export interface HiddenVtTerminal {
  readonly term: RenderTerminal;
  readonly serializer: HistorySerializer;
  /** Atomic UI handoff; the host keeps the old terminal interactive until this call. */
  present(addedRows: number): void;
  discard(): void;
}

interface RestoreStage {
  cols: number;
  rows: number;
  history: VtHistoryHeader;
  data: Uint8Array;
  received: number;
  nativePage?: { rows: number; proof: string };
  nativeSeed?: true;
}
interface VisibleNativeState {
  first: ReturnType<CheckpointTerminal["registerMarker"]>;
  dropped: boolean;
  nativeAnchorLost: boolean;
  nativeVerified: boolean;
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
  private hidden: {
    surface: HiddenVtTerminal;
    addedRows: number;
    previous: VisibleNativeState;
  } | null = null;
  private seedAlternateEntry?: { dispose(): void };
  private nativeAnchorLost = false;
  private nativeVerified = false;
  private hiddenSeedVerified = false;
  private presenting = false;

  constructor(
    private visibleTerm: RenderTerminal,
    private visibleSerializer: HistorySerializer,
    private readonly document: string,
    private readonly post: (event: VtRendererEvent) => void,
    private readonly beforeRebuild: () => void = () => {},
    private readonly createHidden?: () => HiddenVtTerminal,
  ) {}

  get rebuilding(): boolean {
    return !this.hidden && (this.replacing || (this.mode !== "live" && this.mode !== "legacy"));
  }
  get buildingHidden(): boolean {
    return this.hidden !== null;
  }
  private get term(): RenderTerminal {
    return this.hidden?.surface.term ?? this.visibleTerm;
  }
  private get serializer(): HistorySerializer {
    return this.hidden?.surface.serializer ?? this.visibleSerializer;
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
  get nativeHistoryValid(): boolean {
    return this.nativeVerified && !this.nativeAnchorLost && !!this.first && !this.first.isDisposed;
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
    this.discardHidden();
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
        const recoverPage =
          !this.presenting &&
          (this.hidden !== null ||
            (error instanceof RenderFailure && error.reason === "history-rebuild"));
        this.mode = recoverPage ? "live" : "empty";
        this.replacing = false;
        this.stage = null;
        if (this.hidden || !recoverPage) {
          this.clearMarker();
          this.clearReader();
          this.discardHidden(recoverPage);
        }
        this.presenting = false;
        this.post({
          ...reply,
          type: "vt-error",
          reason: recoverPage
            ? "history-rebuild"
            : error instanceof RenderFailure
              ? error.reason
              : "renderer",
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
    const previous: VisibleNativeState = {
      first: this.first,
      dropped: this.dropped,
      nativeAnchorLost: this.nativeAnchorLost,
      nativeVerified: this.nativeVerified,
    };
    if (message.reset && command) throw new RenderFailure("invalid-transfer");
    const starts =
      Boolean(message.reset) || command?.kind === "capture" || command?.kind === "restore";
    if (!starts && this.epoch !== epoch) throw new RenderFailure("invalid-transfer");
    if (starts) this.epoch = epoch;
    if (starts && this.hidden && !(command?.kind === "restore" && command.nativePage)) {
      this.clearMarker();
      this.clearReader();
      this.discardHidden(true);
      this.mode = "live";
      this.replacing = false;
    }
    if (starts) {
      this.nativeAnchorLost = false;
      this.nativeVerified = false;
    }
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
        if (command.nativePage) {
          if (
            !this.createHidden ||
            this.hidden ||
            this.mode !== "live" ||
            !Number.isSafeInteger(command.nativePage.rows) ||
            command.nativePage.rows < 1 ||
            command.nativePage.rows > STREAM_LIMITS.historyLines ||
            command.nativePage.rows > history.rows ||
            !/^[a-f0-9]{64}$/.test(command.nativePage.proof)
          )
            throw new RenderFailure("invalid-transfer");
          try {
            this.hidden = {
              surface: this.createHidden(),
              addedRows: command.nativePage.rows,
              previous,
            };
          } catch {
            Object.assign(this, previous);
            throw new RenderFailure("history-rebuild");
          }
          this.first = undefined;
          this.nativeAnchorLost = false;
          this.hiddenSeedVerified = false;
        } else if (this.hidden) throw new RenderFailure("invalid-transfer");
        this.clearMarker();
        this.mode = "history";
        this.replacing = false;
        this.clearReader();
        if (!this.hidden) this.beforeRebuild();
        this.dropped = history.dropped;
        this.stage = {
          cols: command.cols,
          rows: command.rows,
          history: { ...history },
          data: new Uint8Array(history.bytes),
          received: 0,
          ...(command.nativePage ? { nativePage: command.nativePage } : {}),
          ...(command.nativeSeed ? { nativeSeed: true } : {}),
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
          this.observeEviction();
          this.seedAlternateEntry?.dispose();
          this.seedAlternateEntry = undefined;
          if (command.native) {
            const native = command.native;
            const valid =
              !this.nativeAnchorLost &&
              Number.isSafeInteger(native.precedingRows) &&
              native.precedingRows >= 0 &&
              Number.isSafeInteger(native.rows) &&
              native.rows >= 0 &&
              native.rows <= 2000 &&
              this.term.buffer.normal.baseY === native.precedingRows + native.rows &&
              this.proof(native.precedingRows, native.rows) === native.proof;
            this.post({
              type: "vt-native-proof",
              document: this.document,
              sequence: message.sequence,
              epoch,
              valid,
              normalRows: this.term.buffer.normal.baseY,
            });
            this.nativeVerified = valid;
            if (this.hidden) this.hiddenSeedVerified = valid;
            if (!valid && this.hidden) throw new RenderFailure("invalid-transfer");
          }
          this.mode = "live";
          if (this.reader && this.term.buffer.active.type === "normal")
            this.term.scrollToLine(this.reader.isDisposed ? 0 : this.reader.line);
          this.clearReader();
          this.trackFirst();
        }
        return;
      case "present": {
        const hidden = this.hidden;
        if (!hidden || this.mode !== "live" || bytes.length > 0 || !this.hiddenSeedVerified)
          throw new RenderFailure("checkpoint-missing");
        this.presenting = true;
        hidden.surface.present(hidden.addedRows);
        this.presenting = false;
        hidden.previous.first?.dispose();
        this.visibleTerm = hidden.surface.term;
        this.visibleSerializer = hidden.surface.serializer;
        this.hidden = null;
        this.replacing = false;
        this.post({
          type: "vt-native-proof",
          document: this.document,
          sequence: message.sequence,
          epoch,
          valid: this.nativeHistoryValid,
          normalRows: this.term.buffer.normal.baseY,
        });
        return;
      }
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
      () => {
        if (active())
          this.post({
            type: "vt-progress",
            document: this.document,
            sequence: this.sequence,
            epoch: this.epoch!,
          });
      },
    );
    if (active()) {
      if (stage.nativePage && this.proof(0, stage.nativePage.rows) !== stage.nativePage.proof)
        throw new RenderFailure("invalid-transfer");
      this.stage = null;
      this.mode = "seed";
      // An initial empty grid is deliberately erased by the source preamble. Only
      // protect an already restored prefix here; the seed's own rows are proved
      // from their rendered text before their first marker is installed below.
      if (stage.nativePage || (stage.nativeSeed && stage.history.rows > 0)) this.trackFirst();
      else if (stage.nativeSeed) {
        // xterm can register a marker only in its active buffer. Observe the
        // source entering alternate mode, after its normal prefix was written,
        // and protect that prefix without changing or consuming the mode switch.
        this.seedAlternateEntry = this.term.parser?.registerCsiHandler(
          { prefix: "?", final: "h" },
          (params) => {
            if (params.some((value) => value === 47 || value === 1047 || value === 1049))
              this.trackFirst();
            return false;
          },
        );
      }
    }
  }
  private proof(from: number, count: number): string | null {
    const rows: string[] = [];
    for (let i = from; i < from + count; i++) {
      const line = this.term.buffer.normal.getLine(i);
      if (!line) return null;
      rows.push(line.translateToString(true));
    }
    return nativeHistoryProof(this.term.cols, rows);
  }
  private discardHidden(restoreVisible = false): void {
    const hidden = this.hidden;
    hidden?.surface.discard();
    this.hidden = null;
    if (hidden) {
      if (restoreVisible) Object.assign(this, hidden.previous);
      else hidden.previous.first?.dispose();
    }
  }
  private clearReader(): void {
    this.reader?.dispose();
    this.reader = undefined;
  }
  private clearMarker(): void {
    this.seedAlternateEntry?.dispose();
    this.seedAlternateEntry = undefined;
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
    if (this.first?.isDisposed) this.nativeAnchorLost = true;
    // A program clearing its own screen is not evidence of a phone memory limit.
    if (this.first?.isDisposed && this.term.buffer.normal.baseY >= TERMINAL_BUFFER_LIMIT)
      this.dropped = true;
  }
}
