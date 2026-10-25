import type { ConversationWireEntry } from "@shellbell/protocol";
import { describe, expect, it } from "vitest";
import { conversationRows, stepWaiting, workTitle } from "../src/conversation/conversation-rows";
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

  it("keeps a work row's key while live steps are added", () => {
    const reply = entry("assistant", "Checking");
    const first = [reply, call("Bash · one"), result()];
    const before = conversationRows(first)[1]!;
    const after = conversationRows([...first, call("Bash · two"), result()])[1]!;
    expect(after.key).toBe(before.key);
    expect(
      conversationRows([...first, entry("assistant", "Done"), call("Read · a")])[3]!.key,
    ).not.toBe(before.key);
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

it("names Antigravity's tools like the others", () => {
  const rows = conversationRows([
    call("Read file · a.md"),
    result(),
    call("Run command · make test"),
    result(),
    call("Grep search · TODO"),
    result(),
  ]);
  expect(rows[0]).toMatchObject({ title: "Read 1 file, ran 1 command, searched once" });
});

describe("reply Markdown", () => {
  it("draws a divider for ---, but not under a paragraph line", () => {
    expect(markdownBlocks("One\n\n---\n\nTwo").map((block) => block.kind)).toEqual([
      "paragraph",
      "rule",
      "paragraph",
    ]);
    expect(markdownBlocks("One\n---").map((block) => block.kind)).toEqual(["paragraph"]);
  });

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

describe("steps without a result", () => {
  it("leaves one-line work out of call pairing and never calls it waiting", () => {
    const rows = conversationRows([
      entry("group", "Web search", { collapsed: true }),
      call("Bash · make"),
      result(),
    ]);
    if (rows[0]?.kind !== "work") throw new Error("no work row");
    const [search, make] = rows[0].steps;
    expect(search).toMatchObject({ result: null });
    expect(stepWaiting(search!)).toBe(false);
    expect(make?.result?.detail).toBe("output");
    expect(stepWaiting(make!)).toBe(false);
    const pending = conversationRows([call("Read · a")])[0];
    if (pending?.kind !== "work") throw new Error("no work row");
    expect(stepWaiting(pending.steps[0]!)).toBe(true);
  });
});

describe("reply Markdown as agents write it", () => {
  it("starts a list right under a paragraph line", () => {
    expect(markdownBlocks("Changes:\n- a\n- b").map((block) => block.kind)).toEqual([
      "paragraph",
      "list",
    ]);
    expect(markdownBlocks("Steps:\n1. one\n2. two")[1]).toMatchObject({
      kind: "list",
      ordered: true,
    });
    // A number mid-sentence that doesn't start at 1 stays part of the paragraph.
    expect(markdownBlocks("We shipped in\n2024. It went well.").map((b) => b.kind)).toEqual([
      "paragraph",
    ]);
  });

  it("keeps a code block inside a list item as code", () => {
    const blocks = markdownBlocks("1. Run:\n   ```bash\n   make test\n   ```\n2. Done");
    expect(blocks.map((block) => block.kind)).toEqual(["list", "code", "list"]);
    expect(blocks[1]).toMatchObject({ kind: "code", language: "bash", text: "make test" });
  });

  it("reads a long run of brackets in linear time", () => {
    const text = "[".repeat(40_000);
    const start = performance.now();
    expect(markdownInline(text)).toEqual([{ kind: "text", text }]);
    expect(performance.now() - start).toBeLessThan(100);
  });
});
