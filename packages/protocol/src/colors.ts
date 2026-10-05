import type { Color } from "./screen.js";

/** Spec 10.9 terminal16 palette (dark theme). */
export const TERMINAL16: readonly string[] = [
  "#1c1c1e",
  "#f87171",
  "#4ade80",
  "#fbbf24",
  "#60a5fa",
  "#c084fc",
  "#22d3ee",
  "#d4d4d8",
  "#52525b",
  "#fca5a5",
  "#86efac",
  "#fde68a",
  "#93c5fd",
  "#d8b4fe",
  "#67e8f9",
  "#ffffff",
];

const CUBE = [0, 95, 135, 175, 215, 255];

function hex2(n: number): string {
  n = Math.max(0, Math.min(255, Math.round(n)));
  return n.toString(16).padStart(2, "0");
}

export function xterm256Hex(index: number, theme16: readonly string[] = TERMINAL16): string {
  index = Math.max(0, Math.min(255, Math.round(index)));
  if (index < 16) return theme16[index] ?? "#ffffff";
  if (index < 232) {
    const i = index - 16;
    const r = CUBE[Math.floor(i / 36)] as number;
    const g = CUBE[Math.floor(i / 6) % 6] as number;
    const b = CUBE[i % 6] as number;
    return `#${hex2(r)}${hex2(g)}${hex2(b)}`;
  }
  const v = 8 + (index - 232) * 10;
  return `#${hex2(v)}${hex2(v)}${hex2(v)}`;
}

export function colorToHex(
  c: Color | undefined,
  fallback: string,
  theme16: readonly string[] = TERMINAL16,
): string {
  if (c === undefined) return fallback;
  if (typeof c === "number") return xterm256Hex(c, theme16);
  return `#${hex2(c[0])}${hex2(c[1])}${hex2(c[2])}`;
}
