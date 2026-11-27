import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  blockedPrompt,
  type PromptScreen,
  promptDialog,
  promptEvidence,
} from "../src/agent-prompt.js";

/**
 * Screens from Claude Code and Codex prompts, and what they show. The phone's waiting card and
 * the computer's check before input from Chat both read them with this one reader.
 */
const vectors = JSON.parse(
  readFileSync(join(import.meta.dirname, "fixtures/agent-prompt-vectors.json"), "utf8"),
) as { name: string; screen: PromptScreen; evidence: string | null }[];

describe("agent prompt evidence", () => {
  it.each(vectors)("reads $name", ({ screen, evidence }) => {
    expect(promptEvidence(blockedPrompt(screen))).toBe(evidence);
  });
  it("covers menus, y/n prompts and screens that are neither", () => {
    expect(new Set(vectors.map((vector) => vector.evidence))).toEqual(
      new Set(["menu", "yes-no", null]),
    );
  });
  it("says nothing for no screen", () => {
    expect(promptEvidence(blockedPrompt(undefined))).toBeNull();
  });
});

/** A plain-text screen as a prompt screen, with the cursor on its last row of text. */
function textScreen(text: string): PromptScreen {
  const rows = text.replace(/\n$/, "").split("\n");
  let last = rows.length - 1;
  while (last > 0 && !rows[last]!.trim()) last--;
  return {
    cursor: { x: 0, y: last },
    lines: rows.map((t) => ({ r: t ? [{ t }] : [] })) as PromptScreen["lines"],
  };
}
const screen = (name: string) =>
  textScreen(readFileSync(join(import.meta.dirname, "fixtures/prompt-screens", name), "utf8"));

describe("an agent's whole dialog, for answering it", () => {
  it("reads Claude Code's Bash dialog from its rule to its last choice", () => {
    const dialog = promptDialog(screen("claude-2.1.332-bash.txt"))!;
    expect(dialog.body[0]).toBe("Bash command");
    expect(dialog.body).toContain("touch second-file.txt");
    expect(dialog.body).toContain("Do you want to proceed?");
    expect(dialog.options.map((o) => o.digit)).toEqual(["1", "2", "3", "4"]);
    expect(dialog.options[3]!.label).toBe("No");
    // The wrapped second choice keeps its whole folder and what it grants.
    expect(dialog.options[1]!.label).toMatch(
      /^Yes, and always allow access to .+-shell\nbell\/.+ from this project$/s,
    );
    expect(dialog.highlighted).toBe(0);
    expect(dialog.key).toContain("touch second-file.txt");
  });

  it("reads Codex's command approval, which has no frame, from after the blank rows", () => {
    const dialog = promptDialog(screen("codex-0.172.0-exec.txt"))!;
    expect(dialog.body[0]).toBe("Would you like to run the following command?");
    expect(dialog.body).toContain("$ touch codex-file.txt");
    expect(dialog.options.map((o) => o.label)).toEqual([
      "Yes, proceed",
      "Yes, and don't ask again for commands that start with `touch codex-file.txt`",
      "No, and tell Codex what to do differently",
    ]);
    expect(dialog.rows.some((row) => row.includes("• Running"))).toBe(false);
  });

  it("tells two commands with the same question and choices apart", () => {
    const text = readFileSync(
      join(import.meta.dirname, "fixtures/prompt-screens/codex-0.172.0-exec.txt"),
      "utf8",
    );
    const other = promptDialog(
      textScreen(text.replace("$ touch codex-file.txt", "$ rm -rf build")),
    );
    expect(other!.key).not.toBe(promptDialog(textScreen(text))!.key);
  });

  it("keeps the spaces inside a command, so two commands never match", () => {
    const text = readFileSync(
      join(import.meta.dirname, "fixtures/prompt-screens/codex-0.172.0-exec.txt"),
      "utf8",
    );
    const one = promptDialog(textScreen(text.replace("$ touch codex-file.txt", "$ touch 'a b'")));
    const two = promptDialog(textScreen(text.replace("$ touch codex-file.txt", "$ touch 'a  b'")));
    expect(one!.key).not.toBe(two!.key);
  });

  it("reads Codex's dialog with any number of blank rows above its header", () => {
    const text = readFileSync(
      join(import.meta.dirname, "fixtures/prompt-screens/codex-0.172.0-exec.txt"),
      "utf8",
    );
    const tight = text.replace(/\n{3,}(\s*Would you like)/, "\n\n$1");
    expect(promptDialog(textScreen(tight))!.body[0]).toBe(
      "Would you like to run the following command?",
    );
  });

  it("reads a command with blank rows inside it whole, from Codex's header", () => {
    const text = readFileSync(
      join(import.meta.dirname, "fixtures/prompt-screens/codex-0.172.0-exec.txt"),
      "utf8",
    );
    const heredoc = (file: string) =>
      promptDialog(
        textScreen(
          text.replace(
            "  $ touch codex-file.txt",
            `  $ cat <<EOF > ${file}\n\n\n\n  middle\n  EOF`,
          ),
        ),
      )!;
    expect(heredoc("out.txt").body[0]).toBe("Would you like to run the following command?");
    expect(heredoc("out.txt").key).not.toBe(heredoc("other.txt").key);
  });

  it("tells commands apart by their indentation and blank lines", () => {
    const text = readFileSync(
      join(import.meta.dirname, "fixtures/prompt-screens/codex-0.172.0-exec.txt"),
      "utf8",
    );
    const key = (command: string) =>
      promptDialog(textScreen(text.replace("  $ touch codex-file.txt", command)))!.key;
    expect(key("  $ cat <<EOF\n  a\n  EOF")).not.toBe(key("  $ cat <<EOF\n    a\n  EOF"));
    expect(key("  $ cat <<EOF\n  a\n  EOF")).not.toBe(key("  $ cat <<EOF\n  a\n\n  EOF"));
  });

  it("can't answer when a rule inside the command could pose as the dialog's top", () => {
    const text = readFileSync(
      join(import.meta.dirname, "fixtures/prompt-screens/claude-2.1.332-bash.txt"),
      "utf8",
    );
    const rule = "─".repeat(60);
    const inside = text.replace(
      "\n touch second-file.txt\n",
      `\n cat <<EOF > out.txt\n${rule}\n EOF\n`,
    );
    expect(promptDialog(textScreen(inside))).toBeNull();
  });

  it("can't answer a menu whose end isn't on screen", () => {
    const text = readFileSync(
      join(import.meta.dirname, "fixtures/prompt-screens/claude-2.1.332-bash.txt"),
      "utf8",
    );
    const cut = text.slice(0, text.indexOf("   3. Yes"));
    expect(promptDialog(textScreen(cut))).toBeNull();
  });

  it("can't answer a menu once the agent's message prompt is back below it", () => {
    const text = readFileSync(
      join(import.meta.dirname, "fixtures/prompt-screens/codex-0.172.0-exec.txt"),
      "utf8",
    ).replace(/\n+$/, "");
    expect(promptDialog(textScreen(`${text}\n\n› Type your next message\n`))).toBeNull();
    // An empty prompt row too.
    expect(promptDialog(textScreen(`${text}\n\n❯\n`))).toBeNull();
  });

  it("can't answer a dialog whose start isn't in view", () => {
    const rows = Array.from({ length: 30 }, (_, i) => `line ${i}`);
    expect(
      promptDialog(textScreen([...rows, "Proceed?", "❯ 1. Yes", "  2. No"].join("\n"))),
    ).toBeNull();
  });

  it("can't answer the menus the waiting check can't read", () => {
    for (const vector of vectors.filter((v) => v.evidence !== "menu"))
      expect(promptDialog(vector.screen), vector.name).toBeNull();
  });
});
