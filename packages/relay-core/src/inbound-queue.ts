import type { QueueBudget } from "./queue-budget.js";

/** Handler credits stay reserved until settlement, including after socket closure. */
export class InboundQueue {
  private readonly pending = new Map<string, number>();

  constructor(
    private readonly budget: QueueBudget,
    private readonly maxPending: number,
  ) {
    if (!Number.isSafeInteger(maxPending) || maxPending < 1)
      throw new RangeError("Invalid handler limit");
  }

  admit(connId: string, length: number): (() => void) | null {
    if (!Number.isSafeInteger(length) || length < 0) throw new RangeError("Invalid frame length");
    const count = this.pending.get(connId) ?? 0;
    const credit = length + 256;
    if (count >= this.maxPending || !this.budget.reserve(connId, credit)) return null;
    this.pending.set(connId, count + 1);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.budget.release(connId, credit);
      const remaining = this.pending.get(connId)! - 1;
      if (remaining) this.pending.set(connId, remaining);
      else this.pending.delete(connId);
    };
  }
}
