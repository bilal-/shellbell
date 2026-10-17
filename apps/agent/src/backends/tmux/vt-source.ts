import { EventEmitter } from "node:events";
import type { Logger } from "../../log.js";
import { TmuxControl } from "./control.js";
import { buildSeed, type Seed, seedCommands } from "./vt-seed.js";

/** Why a source stopped; it never restarts itself. */
export type TmuxVtEnd = "pane-gone" | "exited" | "unsettled" | "failed";

export interface TmuxVtSourceOptions {
  /** The tmux session (`$N`) that holds `paneId`; the source attaches to it, never creates it. */
  tmuxSessionId: string;
  paneId: string;
  socketName?: string;
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
export class TmuxVtSource extends EventEmitter<{
  seed: [Seed & { generation: number }];
  bytes: [Uint8Array, number];
  end: [TmuxVtEnd];
}> {
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

  constructor(private readonly opts: TmuxVtSourceOptions) {
    super();
    if (!/^\$\d+$/.test(opts.tmuxSessionId) || !/^%\d+$/.test(opts.paneId)) {
      throw new Error("invalid tmux pane identity");
    }
    this.log = opts.log.child({ backend: "tmux", stream: "vt" });
    this.control = (
      opts.controlFactory ??
      ((id) => new TmuxControl({ sessionId: id, socketName: opts.socketName, log: opts.log }))
    )(opts.tmuxSessionId);
    this.control.on("bytes", (pane, data, seq) => {
      if (this.held) this.held.push({ pane, seq, data });
      else if (pane === opts.paneId) this.emit("bytes", data, this.generation);
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

  async start(): Promise<void> {
    await this.control.start();
    if (!this.control.alive) return this.end("exited");
    if (await this.mutePanes()) await this.reseed();
  }

  /** Starts a new generation from a fresh seed, for example after the receiver fell behind. */
  async reseed(): Promise<void> {
    if (this.ended) return;
    if (this.seeding) {
      this.reseedWanted = true;
      return;
    }
    this.seeding = true;
    try {
      for (let attempt = 0; attempt < MAX_SEED_ATTEMPTS && !this.ended; attempt++) {
        this.reseedWanted = false;
        this.held = [];
        const { replies, sentSeq, outputSeq } = await this.control.checkpoint(
          seedCommands(this.opts.paneId, this.opts.historyLines),
        );
        const held = this.held;
        // Another pane's output queued ahead of the reply could have held back this pane's.
        if (
          held.some((r) => r.pane !== this.opts.paneId && r.seq > sentSeq && r.seq <= outputSeq)
        ) {
          await this.mutePanes();
          continue;
        }
        const seed = buildSeed(replies);
        this.size = { cols: seed.cols, rows: seed.rows };
        this.held = undefined;
        this.generation++;
        this.emit("seed", { ...seed, generation: this.generation });
        for (const r of held) {
          if (r.pane === this.opts.paneId && r.seq > outputSeq) {
            this.emit("bytes", r.data, this.generation);
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
    if (size !== `${this.size.cols} ${this.size.rows}`) await this.reseed();
  }

  private end(reason: TmuxVtEnd | undefined): void {
    if (this.ended) return;
    this.ended = true;
    if (this.resizeTimer) clearTimeout(this.resizeTimer);
    this.resizeTimer = null;
    this.held = undefined;
    this.control.stop();
    if (reason) this.emit("end", reason);
  }
}
