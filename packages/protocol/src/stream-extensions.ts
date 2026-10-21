import { CONTINUATION_EXTENSIONS, NATIVE_HISTORY_EXTENSION } from "./stream-wire.js";

/** Select only a complete, mutually implemented continuation contract. Unknown names add nothing. */
export function selectStreamExtensions(
  requested: readonly string[] | undefined,
  supported: readonly string[],
): string[] {
  const continuation = CONTINUATION_EXTENSIONS.every(
    (name) => requested?.includes(name) && supported.includes(name),
  );
  if (!continuation) return [];
  return [
    ...CONTINUATION_EXTENSIONS,
    ...(requested?.includes(NATIVE_HISTORY_EXTENSION) &&
    supported.includes(NATIVE_HISTORY_EXTENSION)
      ? [NATIVE_HISTORY_EXTENSION]
      : []),
  ];
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
