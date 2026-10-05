export type KeyAction = { kind: "text"; text: string } | { kind: "backspace"; count: number };

/** Code-point aware so a surrogate pair counts as one keystroke. */
export function diffTyped(prev: string, next: string): KeyAction[] {
  const a = Array.from(prev);
  const b = Array.from(next);
  let common = 0;
  while (common < a.length && common < b.length && a[common] === b[common]) common++;
  const out: KeyAction[] = [];
  const removed = a.length - common;
  if (removed > 0) out.push({ kind: "backspace", count: removed });
  const added = b.slice(common).join("");
  if (added) out.push({ kind: "text", text: added });
  return out;
}
