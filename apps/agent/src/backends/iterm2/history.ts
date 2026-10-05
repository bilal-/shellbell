import type { GetBufferResponse } from "./gen/iterm2_pb.js";

export interface ITermHistoryFacts {
  readonly overflow: number;
  readonly history: number;
  readonly grid: number;
  readonly firstVisible: number;
  readonly origin: number;
}

function isNonNegativeSafeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function isSafeCoordinate(value: unknown): value is bigint {
  return typeof value === "bigint" && value >= 0n && value <= BigInt(Number.MAX_SAFE_INTEGER);
}

export function parseHistoryFacts(json: string): ITermHistoryFacts | null {
  let value: unknown;
  try {
    value = JSON.parse(json);
  } catch {
    return null;
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;

  const facts = value as Record<string, unknown>;
  const { overflow, history, grid, first_visible: firstVisible } = facts;
  if (
    !isNonNegativeSafeInteger(overflow) ||
    !isNonNegativeSafeInteger(history) ||
    !isNonNegativeSafeInteger(grid) ||
    !isNonNegativeSafeInteger(firstVisible) ||
    grid === 0
  )
    return null;

  const origin = overflow + history;
  if (!Number.isSafeInteger(origin)) return null;
  return { overflow, history, grid, firstVisible, origin };
}

export function hasFullRowRange(response: GetBufferResponse, from: number, to: number): boolean {
  if (
    !isNonNegativeSafeInteger(from) ||
    !isNonNegativeSafeInteger(to) ||
    to < from ||
    response.status !== 0
  )
    return false;

  const range = response.windowedCoordRange?.coordRange;
  const start = range?.start;
  const end = range?.end;
  if (
    !start ||
    !end ||
    start.x !== 0 ||
    end.x !== 0 ||
    !isSafeCoordinate(start.y) ||
    !isSafeCoordinate(end.y) ||
    start.y !== BigInt(from) ||
    end.y !== BigInt(to)
  )
    return false;

  const columns = response.windowedCoordRange?.columns;
  if (columns && (columns.location !== 0n || columns.length !== 0n)) return false;
  return response.contents.length === to - from;
}
