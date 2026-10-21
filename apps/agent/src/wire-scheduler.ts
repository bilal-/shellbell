export interface WireSchedulerOptions {
  now: () => number;
  maxFramesPerSecond?: number;
  onError?: (error: unknown) => void;
}

interface Registration {
  identity: symbol;
  sendOne: () => boolean;
  priority: "terminal" | "background";
}

/** Timer-free admission for synchronous producers offering exactly one actual envelope. */
export class WireScheduler {
  private readonly now: () => number;
  private readonly rate: number;
  private readonly onError: ((error: unknown) => void) | undefined;
  /** Map order is the round-robin cursor; attempted registrations move to the end. */
  private readonly registrations = new Map<string, Registration>();
  private ownership = {};
  private pumping = false;
  private tokens = 0;
  private last: number;

  constructor(options: WireSchedulerOptions) {
    this.now = options.now;
    this.rate = options.maxFramesPerSecond ?? 40;
    this.onError = options.onError;
    if (!Number.isSafeInteger(this.rate) || this.rate <= 0)
      throw new RangeError("wire scheduler rate must be a positive safe integer");
    this.last = this.readClock();
  }

  register(
    key: string,
    sendOne: () => boolean,
    priority: "terminal" | "background" = "terminal",
  ): () => void {
    if (key.length === 0) throw new RangeError("wire scheduler key must not be empty");
    if (priority !== "terminal" && priority !== "background")
      throw new RangeError("invalid wire scheduler priority");
    const identity = Symbol();
    const registration = { identity, sendOne, priority };
    this.registrations.set(key, registration);
    // Owners may retain obsolete cleanups; those need not retain the producer closure.
    return () => this.remove(key, identity);
  }

  pump(): number {
    if (this.pumping) return 0;
    this.pumping = true;
    try {
      this.refill();
      const ownership = this.ownership;
      const initial = [...this.registrations];
      const terminal = initial.filter(([, registration]) => registration.priority === "terminal");
      const admittedTerminal = new Set(terminal.map(([, registration]) => registration));
      const background = initial.filter(
        ([, registration]) => registration.priority === "background",
      );
      let round = terminal;
      let accepted = 0;
      while (this.tokens >= 1 && this.ownership === ownership) {
        if (round.length === 0) {
          const next = background.shift();
          if (!next) break;
          const [key, registration] = next;
          if (this.registrations.get(key) !== registration) continue;
          if (this.offer(key, registration)) {
            accepted++;
            background.push(next);
          }
          // Lower-priority work can make a terminal producer ready synchronously. Recheck
          // the original terminal owners before offering another background envelope.
          // Registrations created during this pump remain deferred until the next pump.
          round = [...this.registrations].filter(([, registration]) =>
            admittedTerminal.has(registration),
          );
          continue;
        }
        const nextRound: typeof round = [];
        for (const [key, registration] of round) {
          if (this.tokens < 1 || this.ownership !== ownership) break;
          if (this.registrations.get(key) !== registration) continue;
          if (this.offer(key, registration)) {
            accepted++;
            nextRound.push([key, registration]);
          }
        }
        round = nextRound;
      }
      return accepted;
    } finally {
      this.pumping = false;
    }
  }

  /** Refill hint only: a ready budget does not imply that any producer can send. */
  nextBudgetAt(): number | null {
    if (!this.pumping) this.refill();
    if (this.registrations.size === 0 || this.tokens >= 1) return null;
    return this.last + ((1 - this.tokens) * 1000) / this.rate;
  }

  clear(): void {
    this.registrations.clear();
    this.ownership = {};
  }

  private remove(key: string, identity: symbol): void {
    if (this.registrations.get(key)?.identity === identity) this.registrations.delete(key);
  }

  private offer(key: string, registration: Registration): boolean {
    this.registrations.delete(key);
    this.registrations.set(key, registration);
    // Reserve before user code: reentrant queries must observe this token as spent.
    this.tokens -= 1;
    try {
      const result = registration.sendOne();
      if (result === true) return true;
      if (result === false) this.tokens += 1;
      else {
        observeRejection(result);
        throw new TypeError("wire producer must return a synchronous boolean");
      }
    } catch (error) {
      // Admission may already have happened; retain the charge and only remove this owner.
      this.remove(key, registration.identity);
      try {
        observeRejection(this.onError?.(error));
      } catch {
        // An observer failure must not prevent healthy links from progressing.
      }
    }
    return false;
  }

  private readClock(): number {
    const now = this.now();
    if (!Number.isFinite(now)) throw new RangeError("wire scheduler clock must be finite");
    return now;
  }

  private refill(): void {
    const now = Math.max(this.last, this.readClock());
    this.tokens = Math.min(this.rate, this.tokens + ((now - this.last) * this.rate) / 1000);
    this.last = now;
  }
}

/** Contain invalid async callback results without awaiting or admitting their eventual values. */
function observeRejection(value: unknown): void {
  if (value === null || (typeof value !== "object" && typeof value !== "function")) return;
  // A fresh native promise assimilates thenables safely, including throwing getters/methods.
  // Do not call methods on the returned object or let settlement change scheduler state.
  void new Promise((resolve) => resolve(value)).catch(() => {});
}
