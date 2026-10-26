/**
 * A tap that starts this soon after rows moved is ignored: the finger was aimed at the old
 * layout, and a slow connection can deliver a backlog of changes just as it lands.
 */
export const TAP_SETTLE_MS = 500;

/**
 * The rows a held list shows: the held rows in their held order, each with its latest content.
 * New rows wait for the release; rows that left stay put, so nothing moves under a finger.
 */
export function holdRows<T>(
  held: readonly T[],
  latest: readonly T[],
  key: (row: T) => string,
): T[] {
  const byKey = new Map(latest.map((row) => [key(row), row]));
  return held.map((row) => byKey.get(key(row)) ?? row);
}

/** Whether a tap that started at `touchedAt` was aimed at the rows as they then stood. */
export function tapLanded(touchedAt: number, movedAt: number): boolean {
  return touchedAt - movedAt >= TAP_SETTLE_MS;
}
