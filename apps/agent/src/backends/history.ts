import { STREAM_LIMITS } from "@shellbell/protocol";
import type { HistoryReadRequest } from "./types.js";

/** Admission shared by the registry and capture-owning native backends. */
export function assertHistoryReadRequest(request: HistoryReadRequest): void {
  if (
    !isSafeNonnegative(request.reported) ||
    !isSafeNonnegative(request.before) ||
    request.before > request.reported ||
    !Number.isSafeInteger(request.count) ||
    request.count < 1 ||
    request.count > STREAM_LIMITS.historyLines ||
    request.capture === null ||
    typeof request.capture !== "object"
  ) {
    throw new RangeError("invalid history read request");
  }
}

function isSafeNonnegative(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 0;
}
