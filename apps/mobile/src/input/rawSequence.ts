import type { NamedKey } from "@shellbell/protocol";
import { diffTyped } from "./differ";

export type RawStep = { kind: "text"; text: string } | { kind: "key"; key: NamedKey };

/**
 * Spec 10.6/15: raw mode's `onChangeText` diff, flattened into the wire-level steps InputBar
 * fires one at a time -- each removed character is its own `input.key backspace`, matching the
 * protocol (there is no repeat-count field on `input.key`).
 */
export function rawChangeSteps(prev: string, next: string): RawStep[] {
  const steps: RawStep[] = [];
  for (const a of diffTyped(prev, next)) {
    if (a.kind === "text") steps.push({ kind: "text", text: a.text });
    else for (let i = 0; i < a.count; i++) steps.push({ kind: "key", key: "backspace" });
  }
  return steps;
}

/**
 * Review I1: once the raw field is empty (right after `submitRaw`, right after switching into
 * raw mode, or right after any send), `onChangeText` never fires for a Backspace press -- there
 * is nothing left to shorten, so the differ above produces nothing. `onKeyPress` is the only
 * remaining signal. No-op when the field still holds text: that keystroke is diffed instead.
 */
export function rawBackspaceOnEmptySteps(current: string): RawStep[] {
  return current === "" ? [{ kind: "key", key: "backspace" }] : [];
}
