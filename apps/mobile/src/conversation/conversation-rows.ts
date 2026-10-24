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

const VERBS: readonly [RegExp, string, string][] = [
  [
    /^(bash|shell|shell command|exec_command|exec|local_shell|run|run command|terminal)$/i,
    "ran 1 command",
    "ran # commands",
  ],
  [/^(read|read file|view|view file|notebookread|cat)$/i, "read 1 file", "read # files"],
  [
    /^(edit|multiedit|write|write file|write to file|replace file content|notebookedit|apply_patch|str_replace|create)$/i,
    "edited 1 file",
    "edited # files",
  ],
  [
    /^(grep|grep search|glob|search|find|find by name|ls|list dir|tool search)$/i,
    "searched once",
    "searched # times",
  ],
  [/^(webfetch|websearch|web search|fetch)$/i, "looked up 1 page", "looked up # pages"],
  [/^(task|agent|subagent activity|related work)$/i, "ran 1 subagent", "ran # subagents"],
  [/^(todowrite|update_plan|taskcreate|taskupdate)$/i, "updated the plan", "updated the plan"],
];

/** `Ran 4 commands, read 2 files`: counts per kind of step, in first-seen order. */
export function workTitle(steps: readonly ConversationStep[]): string {
  const counts = new Map<number, number>();
  for (const step of steps) {
    const source = step.call ?? step.result;
    const tool = source?.kind === "group" ? source.text : stepTool(step.call);
    let kind = VERBS.findIndex(([pattern]) => pattern.test(tool));
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
 * becomes one work row. A work row is keyed by the message before it, which doesn't change
 * as live steps are added, so an opened row stays open while the agent works.
 */
export function conversationRows(entries: readonly Entry[]): ConversationRow[] {
  const rows: ConversationRow[] = [];
  let steps: ConversationStep[] = [];
  let before = "start";
  /** Calls still waiting for a result, as indexes into `steps`. */
  let open: number[] = [];
  const flush = () => {
    if (!steps.length) return;
    rows.push({
      kind: "work",
      key: `work:${before}`,
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
        before = entry.id;
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
    before = entry.id;
    rows.push({
      kind: entry.kind === "user" || entry.kind === "assistant" ? entry.kind : "notice",
      key: entry.id,
      entry,
    });
  }
  flush();
  return rows;
}
