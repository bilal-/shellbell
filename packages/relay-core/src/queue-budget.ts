/** Byte reservations owned by a runtime transport, independent of socket APIs. */
export class QueueBudget {
  private readonly connections = new Map<string, number>();
  private total = 0;
  constructor(
    private readonly connectionBytes = 2 * 1024 * 1024,
    private readonly globalBytes = 64 * 1024 * 1024,
  ) {
    this.validate(connectionBytes);
    this.validate(globalBytes);
  }
  private validate(bytes: number): void {
    if (!Number.isSafeInteger(bytes) || bytes < 0) throw new RangeError("Invalid queue bytes");
  }
  reserve(connId: string, bytes: number): boolean {
    this.validate(bytes);
    const current = this.connections.get(connId) ?? 0;
    if (bytes > this.connectionBytes - current || bytes > this.globalBytes - this.total)
      return false;
    if (bytes) this.connections.set(connId, current + bytes);
    this.total += bytes;
    return true;
  }
  release(connId: string, bytes: number): void {
    this.validate(bytes);
    const current = this.connections.get(connId) ?? 0;
    const released = Math.min(bytes, current);
    this.total -= released;
    if (current === released) this.connections.delete(connId);
    else this.connections.set(connId, current - released);
  }
  drop(connId: string): void {
    this.release(connId, this.connections.get(connId) ?? 0);
  }
}
