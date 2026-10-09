import {
  encodeCbor,
  type Line,
  STREAM_LIMITS,
  type StreamHistoryPage,
  type StreamHistoryRecord,
  StreamHistoryRecordSchema,
  StreamIdSchema,
} from "@shellbell/protocol";

export interface HistoryAnchor {
  subscriptionId: string;
  generation: number;
  before: number;
}

export interface CachedHistoryRow {
  readonly key: string;
  readonly row: number;
  readonly line: Line;
}

export interface HistoryGap {
  readonly from: number;
  readonly to: number;
}

export interface HistoryWindowSnapshot {
  readonly anchor: Readonly<HistoryAnchor>;
  readonly nextBefore: number;
  readonly readOnly: boolean;
  readonly rows: readonly CachedHistoryRow[];
  readonly gaps: readonly HistoryGap[];
  readonly encodedBytes: number;
}

interface StoredRow {
  readonly value: CachedHistoryRow;
  readonly bytes: number;
}

function nonnegativeSafe(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function normalizeAnchor(value: HistoryAnchor): Readonly<HistoryAnchor> | null {
  try {
    const subscriptionId = value.subscriptionId;
    const generation = value.generation;
    const before = value.before;
    if (
      !StreamIdSchema.safeParse(subscriptionId).success ||
      !nonnegativeSafe(generation) ||
      !nonnegativeSafe(before)
    ) {
      return null;
    }
    return Object.freeze({ subscriptionId, generation, before });
  } catch {
    return null;
  }
}

// The protocol schema has already made owned, normalized copies of all line data.
function freezeOwned<T>(value: T): T {
  if (value !== null && typeof value === "object") {
    for (const child of Object.values(value)) freezeOwned(child);
    Object.freeze(value);
  }
  return value;
}

function normalizeRecord(value: StreamHistoryRecord): StreamHistoryRecord | null {
  try {
    const parsed = StreamHistoryRecordSchema.safeParse(value);
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

function makeRows(subscriptionId: string, page: StreamHistoryPage): StoredRow[] {
  return page.lines.map((line, i) => {
    const bytes = encodeCbor(line).length;
    const row = page.from + i;
    return {
      value: Object.freeze({ key: `${subscriptionId}:${row}`, row, line: freezeOwned(line) }),
      bytes,
    };
  });
}

function makeSnapshot(
  anchor: Readonly<HistoryAnchor>,
  nextBefore: number,
  readOnly: boolean,
  stored: readonly StoredRow[],
  encodedBytes: number,
): HistoryWindowSnapshot {
  const rows = stored.map(({ value }) => value);
  const gaps: HistoryGap[] = [];
  let cursor = nextBefore;
  for (const { row } of rows) {
    if (cursor < row) gaps.push(Object.freeze({ from: cursor, to: row }));
    cursor = row + 1;
  }
  if (cursor < anchor.before) gaps.push(Object.freeze({ from: cursor, to: anchor.before }));
  return Object.freeze({
    anchor,
    nextBefore,
    readOnly,
    rows: Object.freeze(rows),
    gaps: Object.freeze(gaps),
    encodedBytes,
  });
}

export class BoundedHistoryWindow {
  private current: HistoryWindowSnapshot;
  private stored: StoredRow[] = [];
  private visibleKey: string | null = null;
  private revision = 0;

  constructor(anchor: HistoryAnchor) {
    const owned = normalizeAnchor(anchor);
    if (!owned) throw new TypeError("Invalid history anchor");
    this.current = makeSnapshot(owned, owned.before, false, [], 0);
  }

  get snapshot(): HistoryWindowSnapshot {
    return this.current;
  }

  prepend(subscriptionId: string, page: StreamHistoryPage): boolean {
    const start = this.current;
    const revision = this.revision;
    if (start.readOnly || subscriptionId !== start.anchor.subscriptionId) return false;
    const owned = normalizeRecord(page);
    if (!owned || owned.status !== "page" || this.revision !== revision || this.current !== start)
      return false;
    if (owned.generation !== start.anchor.generation || owned.before !== start.nextBefore) {
      return false;
    }
    const incoming = makeRows(subscriptionId, owned);
    let count = this.stored.length + incoming.length;
    let bytes = start.encodedBytes + incoming.reduce((total, row) => total + row.bytes, 0);
    const visible = this.stored.find(({ value }) => value.key === this.visibleKey)?.value.row;
    const candidates = this.stored
      .filter(({ value }) => value.key !== this.visibleKey)
      .sort((left, right) => {
        if (visible === undefined) return right.value.row - left.value.row;
        const distance = Math.abs(right.value.row - visible) - Math.abs(left.value.row - visible);
        return distance || right.value.row - left.value.row;
      });
    const removed = new Set<string>();
    for (const candidate of candidates) {
      if (count <= STREAM_LIMITS.cacheLines && bytes <= STREAM_LIMITS.cacheBytes) break;
      removed.add(candidate.value.key);
      count--;
      bytes -= candidate.bytes;
    }
    if (count > STREAM_LIMITS.cacheLines || bytes > STREAM_LIMITS.cacheBytes) return false;
    const retained = this.stored.filter(({ value }) => !removed.has(value.key));
    const stored = [...incoming, ...retained];
    const next = makeSnapshot(start.anchor, owned.nextBefore, false, stored, bytes);
    if (this.revision !== revision || this.current !== start) return false;
    this.stored = stored;
    this.current = next;
    this.revision++;
    return true;
  }

  replace(anchor: HistoryAnchor, page: StreamHistoryRecord, skippedRows = 0): boolean {
    const start = this.current;
    const revision = this.revision;
    const ownedAnchor = normalizeAnchor(anchor);
    if (
      !ownedAnchor ||
      ownedAnchor.subscriptionId === start.anchor.subscriptionId ||
      !nonnegativeSafe(skippedRows) ||
      skippedRows > ownedAnchor.before
    ) {
      return false;
    }
    const ownedPage = normalizeRecord(page);
    if (!ownedPage || this.revision !== revision || this.current !== start) return false;
    if (
      ownedPage.generation !== ownedAnchor.generation ||
      ownedPage.before !== ownedAnchor.before - skippedRows
    ) {
      return false;
    }
    const stored =
      ownedPage.status === "page" ? makeRows(ownedAnchor.subscriptionId, ownedPage) : [];
    const bytes = stored.reduce((total, row) => total + row.bytes, 0);
    const next = makeSnapshot(
      ownedAnchor,
      ownedPage.status === "page" ? ownedPage.nextBefore : ownedPage.before,
      false,
      stored,
      bytes,
    );
    if (this.revision !== revision || this.current !== start) return false;
    this.stored = stored;
    this.visibleKey = null;
    this.current = next;
    this.revision++;
    return true;
  }

  skip(subscriptionId: string, before: number): boolean {
    const start = this.current;
    if (
      start.readOnly ||
      subscriptionId !== start.anchor.subscriptionId ||
      before !== start.nextBefore ||
      before === 0
    ) {
      return false;
    }
    this.current = makeSnapshot(start.anchor, before - 1, false, this.stored, start.encodedBytes);
    this.revision++;
    return true;
  }

  protect(key: string | null): boolean {
    if (key !== null && !this.stored.some(({ value }) => value.key === key)) return false;
    if (key !== this.visibleKey) {
      this.visibleKey = key;
      this.revision++;
    }
    return true;
  }

  detach(): void {
    if (this.current.readOnly) return;
    const start = this.current;
    this.current = makeSnapshot(
      start.anchor,
      start.nextBefore,
      true,
      this.stored,
      start.encodedBytes,
    );
    this.revision++;
  }
}
