import { bytesForKey, type NamedKey } from "@shellbell/protocol";

export interface KeyModifiers {
  shift: boolean;
  control: boolean;
  alt: boolean;
}

export const NO_MODIFIERS: Readonly<KeyModifiers> = { shift: false, control: false, alt: false };

export function modifierLabel(modifiers: KeyModifiers): string {
  return [modifiers.shift && "Shift", modifiers.control && "Control", modifiers.alt && "Alt"]
    .filter(Boolean)
    .join(" ");
}

export function modifiedCharacter(character: string, modifiers: KeyModifiers): string | null {
  if (!/^[\x20-\x7e]$/.test(character)) return null;
  let bytes = modifiers.shift ? character.toUpperCase() : character;
  if (modifiers.control) {
    const code = bytes.toUpperCase().charCodeAt(0);
    if (character === " ") bytes = "\x00";
    else if (character === "?") bytes = "\x7f";
    else if (code >= 64 && code <= 95) bytes = String.fromCharCode(code - 64);
    else return null;
  }
  return modifiers.alt ? `\x1b${bytes}` : bytes;
}

/** Standard terminal encodings; no operating-system shortcuts or unnegotiated keyboard mode. */
export function modifiedKey(key: NamedKey, modifiers: KeyModifiers): string | null {
  const mask = Number(modifiers.shift) + 2 * Number(modifiers.alt) + 4 * Number(modifiers.control);
  if (mask === 0) return bytesForKey(key);
  if (/^ctrl-[a-z]$/.test(key))
    return modifiedCharacter(key.slice(5), { ...modifiers, control: true });
  if (key === "ctrl-space") return modifiers.alt ? "\x1b\x00" : "\x00";
  if (key === "tab" || key === "shift-tab") {
    if (modifiers.control) return null;
    const bytes = modifiers.shift || key === "shift-tab" ? "\x1b[Z" : "\t";
    return modifiers.alt ? `\x1b${bytes}` : bytes;
  }
  if (key === "enter" || key === "esc" || key === "backspace") {
    if (modifiers.shift || (modifiers.control && key !== "backspace")) return null;
    const bytes = modifiers.control ? "\x08" : bytesForKey(key);
    return modifiers.alt ? `\x1b${bytes}` : bytes;
  }
  const bytes = bytesForKey(key);
  const sequence = bytes.startsWith("\x1b") ? bytes.slice(1) : "";
  const cursor = /^\[([ABCDHF])$/.exec(sequence);
  if (cursor) return `\x1b[1;${mask + 1}${cursor[1]}`;
  const functionKey = /^O([PQRS])$/.exec(sequence);
  if (functionKey) return `\x1b[1;${mask + 1}${functionKey[1]}`;
  const numbered = /^\[(\d+)~$/.exec(sequence);
  return numbered ? `\x1b[${numbered[1]};${mask + 1}~` : null;
}
