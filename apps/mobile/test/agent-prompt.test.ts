import { describe, expect, it } from "vitest";
import {
  agentName,
  agentPlaceholder,
  blockedPrompt,
  MENU_LABEL_MAX,
} from "../src/input/agentPrompt";
import { textScreen } from "../src/input/secretPrompt";

/** A screen whose cursor sits on the row marked `@` (the marker itself is not shown). */
function screen(text: string) {
  const rows = text.split("\n");
  let y = rows.findIndex((r) => r.startsWith("@"));
  if (y >= 0) rows[y] = rows[y]!.slice(1);
  else y = rows.length - 1;
  return { cursor: { x: 0, y }, lines: rows.map((t) => ({ r: t ? [{ t }] : [] })) };
}

const CLAUDE_BASH_BOXED = `
 ✻ Running tests…
╭──────────────────────────────────────────────────────────────────────────────╮
│ Bash command                                                                 │
│                                                                              │
│   npm run test -- --watch=false                                              │
│   Run the unit tests once                                                    │
│                                                                              │
│ Do you want to proceed?                                                      │
│ ❯ 1. Yes                                                                     │
│   2. Yes, and don't ask again for npm run test commands in /Users/me/app     │
│   3. No, and tell Claude what to do differently (esc)                        │
╰──────────────────────────────────────────────────────────────────────────────╯
@`;

const CLAUDE_EDIT = `
⏺ I'll fix the off-by-one in the pager.

────────────────────────────────────────────────────────────────────────────────
 Edit file
 src/pager.ts
   41 -  const end = start + size;
   41 +  const end = start + size - 1;
────────────────────────────────────────────────────────────────────────────────
 Do you want to make this edit to pager.ts?
 ❯ 1. Yes
   2. Yes, allow all edits during this session (shift+tab)
   3. No, and tell Claude what to do differently (esc)
@`;

const CODEX_EXEC = `
• Ran cargo fmt

  Would you like to run the following command?

  Reason: Run the test suite to confirm the fix

  $ cargo test -p shellbell-core

› 1. Yes, proceed (y)
  2. Yes, and don't ask again for this command (a)
  3. No, and tell Codex what to do differently (esc)

@  Press enter to confirm or esc to cancel`;

const CLAUDE_QUESTION = `
 Which database should the cache use?

 ❯ 1. PostgreSQL
      Relational, already used by the API
   2. SQLite
      Embedded, no server to run
   3. Type something.
@`;

describe("numbered agent menus", () => {
  it("reads a boxed Claude Code permission prompt", () => {
    expect(blockedPrompt(screen(CLAUDE_BASH_BOXED))).toEqual({
      question: "Do you want to proceed?",
      options: [
        { digit: "1", label: "Yes" },
        { digit: "2", label: "Yes, and don't ask again for npm run test comma…" },
        { digit: "3", label: "No, and tell Claude what to do differently" },
      ],
    });
  });

  it("reads the same menu from a raw stream's plain rows", () => {
    const rows = CLAUDE_BASH_BOXED.split("\n");
    expect(blockedPrompt(textScreen(rows, rows.length - 1)).options).toHaveLength(3);
  });

  it("reads Claude Code's ruled edit prompt and drops the key hints", () => {
    expect(blockedPrompt(screen(CLAUDE_EDIT))).toEqual({
      question: "Do you want to make this edit to pager.ts?",
      options: [
        { digit: "1", label: "Yes" },
        { digit: "2", label: "Yes, allow all edits during this session" },
        { digit: "3", label: "No, and tell Claude what to do differently" },
      ],
    });
  });

  it("reads a Codex command approval and finds its question over the command", () => {
    expect(blockedPrompt(screen(CODEX_EXEC))).toEqual({
      question: "Would you like to run the following command?",
      options: [
        { digit: "1", label: "Yes, proceed" },
        { digit: "2", label: "Yes, and don't ask again for this command" },
        { digit: "3", label: "No, and tell Codex what to do differently" },
      ],
    });
  });

  it("skips each choice's description rows", () => {
    expect(blockedPrompt(screen(CLAUDE_QUESTION))).toEqual({
      question: "Which database should the cache use?",
      options: [
        { digit: "1", label: "PostgreSQL" },
        { digit: "2", label: "SQLite" },
        { digit: "3", label: "Type something." },
      ],
    });
  });

  it("reads the highlighted menu under a numbered plan in the agent's answer", () => {
    const plan = `⏺ Plan:
  1. Reproduce the crash
  2. Patch the pager
${CLAUDE_EDIT}`;
    expect(blockedPrompt(screen(plan)).options?.map((o) => o.label)).toEqual([
      "Yes",
      "Yes, allow all edits during this session",
      "No, and tell Claude what to do differently",
    ]);
  });

  it("keeps a wrapped choice whole and stops at nine", () => {
    const nine = Array.from({ length: 9 }, (_, i) => `${i ? "  " : "❯ "}${i + 1}. Option ${i + 1}`);
    const menu = blockedPrompt(
      screen(
        [
          "Pick a branch to check out?",
          ...nine.slice(0, 2),
          "     continued on a second row",
          ...nine.slice(2),
          "  10. Option 10",
          "@",
        ].join("\n"),
      ),
    );
    expect(menu.options?.map((o) => o.digit)).toEqual([
      "1",
      "2",
      "3",
      "4",
      "5",
      "6",
      "7",
      "8",
      "9",
    ]);
    expect(menu.options?.[1]?.label).toBe("Option 2");
    expect(Array.from(menu.options?.[0]?.label ?? "").length).toBeLessThanOrEqual(MENU_LABEL_MAX);
  });

  it.each([
    [
      "a plain numbered list in the agent's answer",
      "Here is the plan:\n1. Read the failing test\n2. Fix the pager\n3. Run the suite\n@Proceed? [y/N]",
    ],
    ["two highlighted rows", "Do you want to proceed?\n❯ 1. Yes\n❯ 2. No\n@"],
    [
      "two highlighted menus on screen",
      "Continue?\n❯ 1. Yes\n  2. No\n\nAllow edits?\n❯ 1. Yes\n  2. No\n@",
    ],
    ["a list out of sequence", "Do you want to proceed?\n❯ 1. Yes\n  3. No\n@"],
    ["a single choice", "Do you want to proceed?\n❯ 1. Yes\n@"],
    [
      "a menu far from the cursor",
      `Do you want to proceed?\n❯ 1. Yes\n  2. No\n${"\n".repeat(30)}@$ `,
    ],
    ["a shell prompt quoting a numbered draft", "> 1. first idea\n  2. second idea\n@"],
  ])("never guesses at %s", (_name, text) => {
    expect(blockedPrompt(screen(text)).options).toBeNull();
  });

  it("falls back to the cursor row, or the row above it, for the question", () => {
    expect(blockedPrompt(screen("Building…\n@Overwrite config.json? [y/N] "))).toEqual({
      question: "Overwrite config.json? [y/N]",
      options: null,
    });
    expect(blockedPrompt(screen("Continue with the migration?\n@"))).toEqual({
      question: "Continue with the migration?",
      options: null,
    });
    expect(blockedPrompt(undefined)).toEqual({ question: null, options: null });
    expect(blockedPrompt({ cursor: { x: 0, y: -1 }, lines: [] })).toEqual({
      question: null,
      options: null,
    });
  });

  it("reads the bottom of the screen when the cursor is unknown", () => {
    const parsed = screen(CODEX_EXEC);
    expect(blockedPrompt({ ...parsed, cursor: { x: 0, y: -1 } }).options).toHaveLength(3);
  });
});

describe("agent names", () => {
  it.each([
    ["claude", "Claude"],
    ["codex", "Codex"],
    ["gemini", "Gemini"],
    ["unknown", null],
    ["", null],
    [undefined, null],
    ["<script>", null],
    ["a-very-long-agent-name-indeed", null],
  ])("names %j as %j", (kind, name) => {
    expect(agentName(kind)).toBe(name);
    expect(agentPlaceholder(kind)).toBe(`Message ${name ?? "the agent"}…`);
  });
});
