import { CONTINUATION_EXTENSIONS } from "./stream-wire.js";

/** Select only a complete, mutually implemented continuation contract. Unknown names add nothing. */
export function selectStreamExtensions(
  requested: readonly string[] | undefined,
  supported: readonly string[],
): string[] {
  return CONTINUATION_EXTENSIONS.every(
    (name) => requested?.includes(name) && supported.includes(name),
  )
    ? [...CONTINUATION_EXTENSIONS]
    : [];
}

/** A peer cannot opt the phone in to an extension it did not request. */
export function acceptsContinuation(
  requested: readonly string[],
  accepted: readonly string[],
): boolean {
  return (
    accepted.every((name) => requested.includes(name)) &&
    CONTINUATION_EXTENSIONS.every((name) => accepted.includes(name))
  );
}
