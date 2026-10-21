import { EventEmitter } from "node:events";
import type { Logger } from "../../log.js";
import type { VtSeed, VtSource, VtSourceEnd } from "../types.js";
import { TmuxControl } from "./control.js";
import { ScreenNameFilter } from "./screen-name.js";
import { buildSeed, seedCommands } from "./vt-seed.js";

export interface TmuxVtSourceOptions {
  /** The tmux session (`$N`) that holds `paneId`; the source attaches to it, never creates it. */
  tmuxSessionId: string;
  paneId: string;
  socketName?: string;
  /** The tmux program; `tmux` on PATH when absent. */
  executable?: string;
  log: Logger;
  /** Newest history lines in each seed; all of tmux's history when absent. */
  historyLines?: number;
  /** Quiet time after a layout change before a resized pane is seeded again. */
  resizeDebounceMs?: number;
  controlFactory?: (tmuxSessionId: string) => TmuxControl;
}

/** Seeds that keep catching another pane's output before giving up. */
const MAX_SEED_ATTEMPTS = 5;

/**
 * One pane's terminal as a seed and then the pane's own bytes, through a control client of its
 * own. tmux queues a pane's output and updates its grid in one step, so a capture's reply falls
 * exactly between two output lines of that pane, unless another pane's output is queued ahead of
 * it; this client therefore turns every other pane in the session off.
 *
 * Every `seed` starts a new generation; `bytes` always continue the latest seed.
 */
export class TmuxVtSource
  extends EventEmitter<{
    seed: [VtSeed];
    bytes: [Uint8Array, number];
    end: [VtSourceEnd];
  }>
  implements VtSource
{
  private readonly control: TmuxControl;
  private readonly log: Logger;
  private generation = 0;
  /** Output since the last seed was requested; `undefined` while streaming. */
  private held: { pane: string; seq: number; data: Uint8Array }[] | undefined = [];
  private size: { cols: number; rows: number } | undefined;
  private seeding = false;
  private reseedWanted = false;
  private resizeTimer: NodeJS.Timeout | null = null;
  private muting: Promise<boolean> | null = null;
  private ended = false;
  private historyLines: number | undefined;
  /** Continues from the latest seed, whose pending escape tail can open a window name. */
  private names = new ScreenNameFilter();
  private reason: "resize" | "refresh" = "refresh";
  private probing: Promise<{ generation: number; quiescent: boolean }> | null = null;
  readonly continuation = {
    cursor: "real" as const,
    alternate: "real" as const,
    probe: () => {
      this.probing ??= this.probe().finally(() => {
        this.probing = null;
      });
      return this.probing;
    },
  };

  constructor(private readonly opts: TmuxVtSourceOptions) {
    super();
    if (!/^\$\d+$/.test(opts.tmuxSessionId) || !/^%\d+$/.test(opts.paneId)) {
      throw new Error("invalid tmux pane identity");
    }
    this.log = opts.log.child({ backend: "tmux", stream: "vt" });
    this.control = (
      opts.controlFactory ??
      ((id) =>
        new TmuxControl({
          sessionId: id,
          socketName: opts.socketName,
          executable: opts.executable,
          log: opts.log,
        }))
    )(opts.tmuxSessionId);
    this.control.on("bytes", (pane, data, seq) => {
      if (this.held) this.held.push({ pane, seq, data });
      else if (pane === opts.paneId) this.emitBytes(this.names.write(data));
      // Another pane's output means a pane appeared since panes were last turned off.
      else void this.mutePanes();
    });
    this.control.on("layout", () => {
      void this.mutePanes().then((present) => {
        if (present) this.scheduleResizeCheck();
      });
    });
    this.control.on("exit", () => this.end("exited"));
  }

  async start(historyLines?: number): Promise<void> {
    this.historyLines = historyLines ?? this.opts.historyLines;
    await this.control.start();
    if (!this.control.alive) return this.end("exited");
    if (await this.mutePanes()) await this.reseed();
  }

  /** Starts a new generation from a fresh seed, for example after the receiver fell behind. */
  async reseed(historyLines?: number): Promise<void> {
    if (this.ended) return;
    if (historyLines !== undefined) this.historyLines = historyLines;
    if (this.seeding) {
      this.reseedWanted = true;
      return;
    }
    this.seeding = true;
    try {
      // Only captures another pane's output got ahead of count; a new seed the receiver asked
      // for (say, with less history) is not a failed attempt.
      for (let attempt = 0; attempt < MAX_SEED_ATTEMPTS && !this.ended; ) {
        this.reseedWanted = false;
        this.held = [];
        const { replies, sentSeq, outputSeq } = await this.control.checkpoint(
          seedCommands(this.opts.paneId, this.historyLines),
        );
        const held = this.held;
        // Another pane's output queued ahead of the reply could have held back this pane's.
        if (
          held.some((r) => r.pane !== this.opts.paneId && r.seq > sentSeq && r.seq <= outputSeq)
        ) {
          attempt++;
          await this.mutePanes();
          continue;
        }
        const seed = buildSeed(replies);
        this.size = { cols: seed.cols, rows: seed.rows };
        this.held = undefined;
        this.generation++;
        this.names = new ScreenNameFilter();
        const data = Buffer.from(this.names.write(Buffer.from(seed.data))).toString();
        const redraw = buildSeed(replies, true);
        const continuation = {
          data: Buffer.from(new ScreenNameFilter().write(Buffer.from(redraw.data))).toString(),
          reason: this.reason,
        };
        this.reason = "refresh";
        this.emit("seed", { ...seed, data, generation: this.generation, continuation });
        for (const r of held) {
          if (r.pane === this.opts.paneId && r.seq > outputSeq) {
            this.emitBytes(this.names.write(r.data));
          }
        }
        if (!this.reseedWanted) return;
      }
      if (!this.ended) this.end("unsettled");
    } catch (err) {
      if (!this.ended) {
        this.log.debug("tmux vt seed failed", {
          error: err instanceof Error ? err.name : "unknown",
        });
        this.end(this.control.alive ? "failed" : "exited");
      }
    } finally {
      this.seeding = false;
    }
  }

  close(): void {
    this.end(undefined);
  }

  /** Output with window names removed; a chunk that was only a name sends nothing. */
  private emitBytes(data: Uint8Array): void {
    if (data.length > 0) this.emit("bytes", data, this.generation);
  }

  /** Turns off every other pane; false, after ending, once this pane is gone. */
  private mutePanes(): Promise<boolean> {
    this.muting ??= this.listAndMute().finally(() => {
      this.muting = null;
    });
    return this.muting;
  }

  private async listAndMute(): Promise<boolean> {
    if (this.ended) return false;
    let panes: string[];
    try {
      panes = await this.control.command(
        `list-panes -s -t ${this.opts.tmuxSessionId} -F '#{pane_id}'`,
      );
    } catch {
      if (!this.ended) this.end(this.control.alive ? "pane-gone" : "exited");
      return false;
    }
    if (!panes.includes(this.opts.paneId)) {
      this.end("pane-gone");
      return false;
    }
    const others = panes.filter((pane) => /^%\d+$/.test(pane) && pane !== this.opts.paneId);
    try {
      for (const pane of others) await this.control.command(`refresh-client -A '${pane}:off'`);
    } catch {
      // A pane that closed meanwhile; the next layout change lists panes again.
    }
    return !this.ended;
  }

  /** Reseeds once layout changes settle, if this pane's size changed. */
  private scheduleResizeCheck(): void {
    if (this.resizeTimer) clearTimeout(this.resizeTimer);
    this.resizeTimer = setTimeout(() => {
      this.resizeTimer = null;
      void this.checkSize();
    }, this.opts.resizeDebounceMs ?? 300);
    this.resizeTimer.unref?.();
  }

  private async checkSize(): Promise<void> {
    if (this.ended || !this.size) return;
    let size: string | undefined;
    try {
      [size] = await this.control.command(
        `display -p -t ${this.opts.paneId} '#{pane_width} #{pane_height}'`,
      );
    } catch {
      return;
    }
    if (size !== `${this.size.cols} ${this.size.rows}`) {
      this.reason = "resize";
      await this.reseed();
    }
  }

  private async probe(): Promise<{ generation: number; quiescent: boolean }> {
    const generation = this.generation;
    const [identity] = await this.control.command(
      `display -p -t ${this.opts.paneId} '#{pane_id} #{pane_width} #{pane_height}'`,
    );
    return {
      generation,
      quiescent:
        !this.ended &&
        !this.seeding &&
        !this.held &&
        generation === this.generation &&
        identity === `${this.opts.paneId} ${this.size?.cols} ${this.size?.rows}`,
    };
  }

  private end(reason: VtSourceEnd | undefined): void {
    if (this.ended) return;
    this.ended = true;
    if (this.resizeTimer) clearTimeout(this.resizeTimer);
    this.resizeTimer = null;
    this.held = undefined;
    this.control.stop();
    if (reason) this.emit("end", reason);
  }
}
