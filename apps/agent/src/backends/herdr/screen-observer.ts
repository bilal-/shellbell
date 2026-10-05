import { createHash } from "node:crypto";
import type { Screen } from "../types.js";

export interface ObservedScreenTarget {
  id: string;
  identity: string;
  current(): boolean;
  read(): Promise<Screen>;
}

interface Observation {
  identity: string;
  digest?: string;
  due: number;
}

interface ScreenObserverOptions {
  targets(): ObservedScreenTarget[];
  changed(id: string): void;
  failed(): void;
  watchedMs?: number;
  backgroundMs?: number;
}

/** Herdr's JSON revisions do not track output. Compare rendered screens with bounded native I/O. */
export class HerdrScreenObserver {
  private run: object | undefined;
  private timer: NodeJS.Timeout | undefined;
  private busy = false;
  private watched = new Set<string>();
  private readonly observations = new Map<string, Observation>();
  private readonly watchedMs: number;
  private readonly backgroundMs: number;

  constructor(private readonly options: ScreenObserverOptions) {
    this.watchedMs = Math.max(125, options.watchedMs ?? 125);
    this.backgroundMs = Math.max(this.watchedMs, options.backgroundMs ?? 1000);
  }

  start(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    this.run = {};
    // A subscription handover must compare its first screen with the last live one.
    // stop() clears all observations when the native connection itself is lost.
    for (const observation of this.observations.values()) observation.due = 0;
    this.schedule();
  }

  stop(): void {
    this.run = undefined;
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    this.observations.clear();
  }

  setWatched(ids: string[]): void {
    const next = new Set(ids);
    for (const id of next) {
      if (!this.watched.has(id)) {
        const observation = this.observations.get(id);
        if (observation) observation.due = 0;
      }
    }
    this.watched = next;
  }

  private schedule(): void {
    if (!this.run || this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      void this.pass().catch(() => this.reportFailure());
    }, this.watchedMs);
    this.timer.unref?.();
  }

  private async pass(): Promise<void> {
    const run = this.run;
    if (!run) return;
    if (this.busy) {
      this.schedule();
      return;
    }
    this.busy = true;
    try {
      const targets = this.options.targets();
      const present = new Set(targets.map((target) => target.id));
      for (const id of this.observations.keys()) {
        if (!present.has(id)) this.observations.delete(id);
      }
      const now = Date.now();
      const due = targets
        .map((target) => {
          let observation = this.observations.get(target.id);
          if (!observation || observation.identity !== target.identity) {
            observation = { identity: target.identity, digest: observation?.digest, due: 0 };
            this.observations.set(target.id, observation);
          }
          return { target, observation };
        })
        .filter(({ observation }) => observation.due <= now)
        .sort((a, b) => a.observation.due - b.observation.due)
        .slice(0, 16);
      let index = 0;
      const worker = async () => {
        while (this.run === run && index < due.length) {
          const item = due[index++];
          if (!item) return;
          const { target, observation } = item;
          try {
            const screen = await target.read();
            if (this.run !== run || !target.current()) continue;
            const digest = createHash("sha256")
              .update(
                JSON.stringify([
                  screen.cols,
                  screen.rows,
                  screen.cursor,
                  screen.lines,
                  screen.scrollbackTotal,
                ]),
              )
              .digest("hex");
            const changed = observation.digest !== undefined && observation.digest !== digest;
            if (changed) this.options.changed(target.id);
            observation.digest = digest;
          } catch {
            if (this.run === run && target.current()) this.reportFailure();
          } finally {
            observation.due =
              Date.now() + (this.watched.has(target.id) ? this.watchedMs : this.backgroundMs);
          }
        }
      };
      await Promise.all(Array.from({ length: Math.min(4, due.length) }, worker));
    } finally {
      this.busy = false;
      this.schedule();
    }
  }

  private reportFailure(): void {
    try {
      this.options.failed();
    } catch {
      // Diagnostics must not terminate the native service.
    }
  }
}
