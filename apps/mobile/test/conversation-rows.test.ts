import type { ConversationWireEntry } from "@shellbell/protocol";
import { describe, expect, it } from "vitest";
import { conversationRows, workTitle } from "../src/conversation/conversation-rows";
import { markdownBlocks, markdownInline } from "../src/conversation/markdown";

let next = 0;
const entry = (
  kind: ConversationWireEntry["kind"],
  text: string,
  extra: Partial<ConversationWireEntry> = {},
): ConversationWireEntry => ({ id: String(++next).padStart(22, "0"), kind, text, ...extra });
const call = (text: string) => entry("tool-call", text, { detail: `${text} args` });
const result = (failed = false) =>
  entry("tool-result", failed ? "Tool error" : "Tool result", { detail: "output" });

describe("conversation rows", () => {
  it("collapses the steps between messages into one work row", () => {
    const rows = conversationRows([
      entry("user", "Fix the build"),
      call("Bash · pnpm test"),
      result(true),
      call("Read · src/a.ts"),
      result(),
      call("Bash · pnpm test"),
      result(),
      entry("assistant", "Fixed."),
    ]);
    expect(rows.map((row) => row.kind)).toEqual(["user", "work", "assistant"]);
    const work = rows[1]!;
    if (work.kind !== "work") throw new Error(work.kind);
    expect(work.title).toBe("Ran 2 commands, read 1 file");
    expect(work.failed).toBe(1);
    expect(work.steps.map((step) => [step.call?.text, step.result?.detail])).toEqual([
      ["Bash · pnpm test", "output"],
      ["Read · src/a.ts", "output"],
      ["Bash · pnpm test", "output"],
    ]);
  });

  it("answers parallel calls in order and keeps a step still running", () => {
    const rows = conversationRows([call("Read · a"), call("Read · b"), result(), call("Grep · x")]);
    if (rows[0]?.kind !== "work") throw new Error("no work row");
    expect(rows[0].steps.map((step) => [step.call?.text, !!step.result])).toEqual([
      ["Read · a", true],
      ["Read · b", false],
      ["Grep · x", false],
    ]);
    expect(rows[0].title).toBe("Read 2 files, searched once");
  });

  it("keys a work row by its newest step so older pages can extend it", () => {
    const older = call("Bash · one");
    const newer = [result(), call("Bash · two"), result()];
    const before = conversationRows(newer)[0]!;
    const after = conversationRows([older, ...newer])[0]!;
    expect(after.key).toBe(before.key);
  });

  it("shows compaction as its own row and other status as notices", () => {
    const rows = conversationRows([
      entry("group", "Conversation summary", { detail: "Summary" }),
      entry("status", "Non-text content omitted"),
      entry("group", "Subagent activity"),
    ]);
    expect(rows.map((row) => row.kind)).toEqual(["summary", "notice", "work"]);
    expect(
      workTitle([
        {
          key: "a",
          call: rows[2]!.kind === "work" ? rows[2]!.steps[0]!.call : null,
          result: null,
          failed: false,
        },
      ]),
    ).toBe("Ran 1 subagent");
  });
});

describe("reply Markdown", () => {
  it("reads the blocks agent replies use", () => {
    const blocks = markdownBlocks(
      [
        "## Plan",
        "",
        "Two steps:",
        "",
        "1. Build",
        "2. Test it",
        "   with care",
        "",
        "- nested",
        "  - item",
        "",
        "> quoted",
        "",
        "```ts",
        "const a = 1;",
        "```",
        "```",
        "unfinished",
      ].join("\n"),
    );
    expect(blocks.map((block) => block.kind)).toEqual([
      "heading",
      "paragraph",
      "list",
      "list",
      "quote",
      "code",
      "code",
    ]);
    expect(blocks[2]).toMatchObject({
      ordered: true,
      items: [
        { marker: "1.", inline: [{ text: "Build" }] },
        { marker: "2.", inline: [{ text: "Test it" }, { text: " with care" }] },
      ],
    });
    expect(blocks[3]).toMatchObject({ items: [{ depth: 0 }, { depth: 1 }] });
    expect(blocks[5]).toEqual({ kind: "code", language: "ts", text: "const a = 1;", open: false });
    expect(blocks[6]).toMatchObject({ text: "unfinished", open: true });
  });

  it("keeps only http links and never reads HTML or images", () => {
    expect(
      markdownInline(
        "Run `pnpm test`, **then** see [docs](https://x.dev) or [x](javascript:alert(1)) ![i](https://x.dev/i.png) <b>hi</b> *done*",
      ),
    ).toEqual([
      { kind: "text", text: "Run " },
      { kind: "code", text: "pnpm test" },
      { kind: "text", text: ", " },
      { kind: "bold", text: "then" },
      { kind: "text", text: " see " },
      { kind: "link", text: "docs", url: "https://x.dev" },
      { kind: "text", text: " or [x](javascript:alert(1)) !" },
      { kind: "link", text: "i", url: "https://x.dev/i.png" },
      { kind: "text", text: " <b>hi</b> " },
      { kind: "italic", text: "done" },
    ]);
  });

  it("leaves snake_case and multiplication alone", () => {
    expect(markdownInline("use snake_case_name and 2*3*4")).toEqual([
      { kind: "text", text: "use snake_case_name and 2*3*4" },
    ]);
  });
});
