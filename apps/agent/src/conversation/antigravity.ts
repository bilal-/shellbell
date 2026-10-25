import type { ConversationEntry } from "./transcript-record.js";
import { transcriptTail, transcriptText } from "./transcript-record.js";

/**
 * Antigravity CLI (`agy`) keeps each conversation in its own SQLite database, one protobuf row
 * per step. There is no published schema, so this reads only the fields below, found in real
 * conversations and pinned by the fixture test. Anything else in a step is ignored, and an
 * unknown step type shows the same placeholder as other adapters.
 */
export const ANTIGRAVITY_STEP = {
  user: 14,
  reply: 15,
  error: 17,
  context: 90,
  notice: 101,
  tool: 132,
} as const;
/** Step statuses Antigravity writes: done, invalid arguments, cancelled, failed or denied. */
const DONE = 3;
const FINAL = new Set([3, 4, 6, 7, 9]);
/** Steps that never show a row: injected context and bookkeeping. */
const HIDDEN = new Set<number>([ANTIGRAVITY_STEP.context, 23]);

const TEXT_BYTES = 16 * 1024;
const DETAIL_BYTES = 8 * 1024;
const RESULT_BYTES = 1024;
const SUMMARY_BYTES = 120;
const MAX_FIELDS = 4096;
const MAX_DEPTH = 12;

type Field = { readonly number: number } & (
  | { readonly wire: 0; readonly value: number }
  | { readonly wire: 2; readonly value: Uint8Array }
);

/**
 * Top-level fields of one protobuf message. Fails closed: malformed input, deep nesting or too
 * many fields return null rather than a partial read.
 */
export function protobufFields(bytes: Uint8Array, depth = 0): Field[] | null {
  if (depth > MAX_DEPTH) return null;
  const fields: Field[] = [];
  let i = 0;
  /** Values past 2^49 are approximate; only number fields, which this reader never uses, have them. */
  let exact = true;
  const varint = (): number | null => {
    let result = 0;
    exact = true;
    for (let shift = 0; shift < 70; shift += 7) {
      if (i >= bytes.length) return null;
      const byte = bytes[i++]!;
      if (shift < 49) result += (byte & 0x7f) * 2 ** shift;
      else if (byte & 0x7f) exact = false;
      if (byte < 0x80) return result;
    }
    return null;
  };
  while (i < bytes.length) {
    if (fields.length >= MAX_FIELDS) return null;
    const key = varint();
    if (key === null || !exact) return null;
    const number = Math.floor(key / 8);
    const wire = key % 8;
    if (number < 1) return null;
    if (wire === 0) {
      const value = varint();
      if (value === null) return null;
      fields.push({ number, wire, value });
    } else if (wire === 2) {
      const length = varint();
      if (length === null || !exact || i + length > bytes.length) return null;
      fields.push({ number, wire, value: bytes.subarray(i, i + length) });
      i += length;
    } else if (wire === 1 || wire === 5) {
      i += wire === 1 ? 8 : 4;
      if (i > bytes.length) return null;
    } else return null;
  }
  return fields;
}

const decoder = new TextDecoder("utf-8", { fatal: true });
/** Follows a path of nested message fields and returns every message at its end. */
function messages(bytes: Uint8Array, path: readonly number[]): Uint8Array[] {
  let current = [bytes];
  for (const [depth, number] of path.entries()) {
    const next: Uint8Array[] = [];
    for (const message of current)
      for (const field of protobufFields(message, depth) ?? [])
        if (field.number === number && field.wire === 2) next.push(field.value);
    current = next;
  }
  return current;
}
function text(bytes: Uint8Array, path: readonly number[]): string | null {
  const [value] = messages(bytes, path);
  if (!value) return null;
  try {
    return decoder.decode(value);
  } catch {
    return null;
  }
}
function texts(bytes: Uint8Array, path: readonly number[]): string[] {
  return messages(bytes, path).flatMap((value) => {
    try {
      return [decoder.decode(value)];
    } catch {
      return [];
    }
  });
}

export interface AntigravityStep {
  readonly idx: number;
  readonly type: number;
  readonly status: number;
  /** Null when the row was too large to read; it shows as a fixed notice. */
  readonly payload: Uint8Array | null;
}

const UNKNOWN = "(Something this version can't show)";
function line(value: string): string {
  const first = value.trim().split("\n", 1)[0]!.trim();
  const cut = transcriptText(first, SUMMARY_BYTES);
  return cut.truncated || first !== value.trim() ? `${cut.text}…` : cut.text;
}
function toolName(name: string): string {
  // `run_command` reads better as `Run command`, closer to the agent's own screen.
  const words = name.replace(/_/g, " ").trim();
  return words ? words.charAt(0).toUpperCase() + words.slice(1) : "Tool";
}
const SUMMARY_ARGUMENTS = ["toolSummary", "CommandLine", "Path", "Query", "Url", "SearchPath"];

/**
 * One step decoded on its own. Only a tool run depends on other steps, for the name of the
 * call it answers, so everything else is final here and can be kept between reads.
 */
export type ParsedStep =
  | {
      readonly kind: "entries";
      readonly entries: readonly ConversationEntry[];
      readonly calls: readonly string[];
    }
  | {
      readonly kind: "tool";
      readonly id: string;
      readonly summary: string | undefined;
      readonly final: boolean;
      readonly result: ConversationEntry | undefined;
    };

function entry(
  idx: number,
  n: number,
  kind: ConversationEntry["kind"],
  value: string,
  detail?: string,
  options: { collapsed?: boolean; truncated?: boolean; tail?: boolean } = {},
): ConversationEntry {
  const main = transcriptText(value, TEXT_BYTES);
  const body =
    detail === undefined
      ? undefined
      : (options.tail ? transcriptTail : transcriptText)(
          detail,
          options.tail ? DETAIL_BYTES : kind === "tool-result" ? RESULT_BYTES : DETAIL_BYTES,
        );
  return Object.freeze({
    id: `agy:${idx}:${n}`,
    kind,
    text: main.text,
    ...(body && { detail: body.text }),
    ...(options.collapsed && { collapsed: true }),
    ...((options.truncated || main.truncated || body?.truncated) && { truncated: true }),
  });
}

export function parseAntigravityStep(step: AntigravityStep): ParsedStep {
  const entries: ConversationEntry[] = [];
  const calls: string[] = [];
  const done = (): ParsedStep => ({ kind: "entries", entries: Object.freeze(entries), calls });
  if (HIDDEN.has(step.type)) return done();
  const add = (
    ...args: Parameters<typeof entry> extends [number, number, ...infer R] ? R : never
  ) => entries.push(entry(step.idx, entries.length, ...args));
  const payload = step.payload;
  if (!payload) {
    add("status", "A step was too large to show here", undefined, { truncated: true });
    return done();
  }
  if (step.type === ANTIGRAVITY_STEP.user) {
    const value = text(payload, [19, 2]);
    if (value?.trim()) add("user", value);
    else add("unsupported", UNKNOWN);
  } else if (step.type === ANTIGRAVITY_STEP.reply) {
    // Field 20.3 is the model's private reasoning and is never shown.
    const reply = text(payload, [20, 1]);
    if (reply?.trim()) add("assistant", reply);
    for (const call of messages(payload, [20, 7])) calls.push(toolName(text(call, [2]) ?? ""));
  } else if (step.type === ANTIGRAVITY_STEP.tool) {
    const keys = texts(payload, [140, 1, 1]);
    const values = texts(payload, [140, 1, 2]);
    const args = new Map(keys.map((key, index) => [key, values[index] ?? ""]));
    const summary = SUMMARY_ARGUMENTS.map((key) => args.get(key)).find((value) => value?.trim());
    const final = FINAL.has(step.status);
    let result: ConversationEntry | undefined;
    if (final) {
      const failed = step.status !== DONE;
      const output = failed
        ? (text(payload, [31, 2]) ?? text(payload, [140, 2, 1]) ?? "")
        : (text(payload, [140, 2, 1]) ?? "");
      result = entry(step.idx, 1, "tool-result", failed ? "Tool error" : "Tool result", output, {
        collapsed: true,
        tail: failed,
      });
    }
    return {
      kind: "tool",
      id: `agy:${step.idx}:0`,
      summary: summary === undefined ? undefined : line(summary),
      final,
      result,
    };
  } else if (step.type === ANTIGRAVITY_STEP.error) {
    const message = text(payload, [24, 3, 2]);
    add("status", message ? line(message) : "Agent reported an error");
  } else if (step.type === ANTIGRAVITY_STEP.notice) {
    const title = text(payload, [114, 2, 1]);
    add("group", title ? `Background task · ${line(title)}` : "Background task", undefined, {
      collapsed: true,
    });
  } else add("unsupported", UNKNOWN);
  return done();
}

/**
 * Turns decoded steps into rows. Calls are announced in a reply and run as later tool steps, in
 * order, so each tool step takes its name from the oldest announced call still waiting.
 */
export function assembleAntigravity(parsed: readonly ParsedStep[]): ConversationEntry[] {
  const entries: ConversationEntry[] = [];
  const calls: string[] = [];
  for (const step of parsed) {
    if (step.kind === "entries") {
      entries.push(...step.entries);
      calls.push(...step.calls);
      continue;
    }
    const name = (step.final ? calls.shift() : calls[0]) ?? "Tool";
    entries.push(
      Object.freeze({
        id: step.id,
        kind: "tool-call" as const,
        text: step.summary ? `${name} · ${step.summary}` : name,
        collapsed: true,
      }),
    );
    if (step.result) entries.push(step.result);
  }
  return entries;
}

export function antigravityEntries(steps: readonly AntigravityStep[]): ConversationEntry[] {
  return assembleAntigravity(steps.map(parseAntigravityStep));
}
