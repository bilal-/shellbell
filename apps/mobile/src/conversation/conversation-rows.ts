import type { ConversationWireEntry } from "@shellbell/protocol";

type Entry = Readonly<ConversationWireEntry>;

/** One tool call and the result that answered it, when the result has arrived. */
export interface ConversationStep {
  readonly key: string;
  readonly call: Entry | null;
  readonly result: Entry | null;
  readonly failed: boolean;
}
export type ConversationRow =
  | { readonly kind: "user" | "assistant" | "notice"; readonly key: string; readonly entry: Entry }
  | { readonly kind: "summary"; readonly key: string; readonly entry: Entry }
  | {
      readonly kind: "work";
      readonly key: string;
      readonly steps: readonly ConversationStep[];
      readonly title: string;
      readonly failed: number;
    };

const WORK = new Set<ConversationWireEntry["kind"]>(["tool-call", "tool-result", "group"]);

/** The tool name before ` · `, which the computer puts ahead of each call's summary. */
export function stepTool(entry: Entry | null): string {
  return entry?.text.split(" · ", 1)[0]?.trim() ?? "";
}

/**
 * What each tool name stands for, across the agents' own names. Names are compared lower-case
 * with underscores as spaces, so `run_command` and Antigravity's `Run command` match alike.
 */
const VERBS: readonly [RegExp, string, string][] = [
  [
    /^(bash|bashoutput|killshell|shell|shell command|exec command|exec|local shell|run|run command|command status|write stdin|terminal)$/,
    "ran 1 command",
    "ran # commands",
  ],
  [/^(read|read file|view|view file|notebookread|cat)$/, "read 1 file", "read # files"],
  [
    /^(edit|multiedit|write|write file|write to file|replace file content|multi replace file content|edit file|notebookedit|apply patch|str replace|create)$/,
    "edited 1 file",
    "edited # files",
  ],
  [
    /^(grep|grep search|glob|search|find|find by name|ls|list dir|tool search)$/,
    "searched once",
    "searched # times",
  ],
  [
    /^(webfetch|websearch|web search|search web|read url content|fetch)$/,
    "looked up 1 page",
    "looked up # pages",
  ],
  [/^(task|agent|subagent activity|related work)$/, "ran 1 subagent", "ran # subagents"],
  [/^background task\b/, "ran 1 background task", "ran # background tasks"],
  [/^(todowrite|update plan|taskcreate|taskupdate)$/, "updated the plan", "updated the plan"],
];

/** A tool call still waiting for its result; one-line work steps never get one. */
export function stepWaiting(step: ConversationStep): boolean {
  return step.call?.kind === "tool-call" && !step.result;
}

/** `Ran 4 commands, read 2 files`: counts per kind of step, in first-seen order. */
export function workTitle(steps: readonly ConversationStep[]): string {
  const counts = new Map<number, number>();
  for (const step of steps) {
    const source = step.call ?? step.result;
    const tool = source?.kind === "group" ? source.text : stepTool(step.call);
    const name = tool.toLowerCase().replace(/_/g, " ").trim();
    let kind = VERBS.findIndex(([pattern]) => pattern.test(name));
    if (kind < 0) kind = VERBS.length;
    counts.set(kind, (counts.get(kind) ?? 0) + 1);
  }
  const parts = [...counts].map(([kind, count]) => {
    if (kind === VERBS.length) return count === 1 ? "used 1 tool" : `used ${count} tools`;
    const [, one, many] = VERBS[kind]!;
    return count === 1 ? one : many.replace("#", String(count));
  });
  const text = parts.join(", ");
  return text.charAt(0).toUpperCase() + text.slice(1);
}

function failed(entry: Entry): boolean {
  return entry.kind === "tool-result" && entry.text === "Tool error";
}

/**
 * Oldest-first rows: messages stand alone, and each stretch of tool steps between them
 * becomes one work row. A work row is keyed by its first step, which doesn't change as live
 * steps are added or older messages load above it, so an opened row stays open.
 */
export function conversationRows(entries: readonly Entry[]): ConversationRow[] {
  const rows: ConversationRow[] = [];
  let steps: ConversationStep[] = [];
  /** Calls still waiting for a result, as indexes into `steps`. */
  let open: number[] = [];
  const flush = () => {
    if (!steps.length) return;
    rows.push({
      kind: "work",
      key: `work:${steps[0]!.key}`,
      steps,
      title: workTitle(steps),
      failed: steps.filter((step) => step.failed).length,
    });
    steps = [];
    open = [];
  };
  for (const entry of entries) {
    if (WORK.has(entry.kind)) {
      if (entry.kind === "group" && entry.text === "Conversation summary") {
        flush();
        rows.push({ kind: "summary", key: entry.id, entry });
      } else if (entry.kind === "tool-result") {
        // Results carry no call ID on the wire. Parallel calls are answered in order.
        const waiting = open.shift();
        if (waiting !== undefined)
          steps[waiting] = { ...steps[waiting]!, result: entry, failed: failed(entry) };
        else steps.push({ key: entry.id, call: null, result: entry, failed: failed(entry) });
      } else {
        steps.push({ key: entry.id, call: entry, result: null, failed: false });
        if (entry.kind === "tool-call") open.push(steps.length - 1);
      }
      continue;
    }
    flush();
    rows.push({
      kind: entry.kind === "user" || entry.kind === "assistant" ? entry.kind : "notice",
      key: entry.id,
      entry,
    });
  }
  flush();
  return rows;
}
