import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { blockedPrompt, type PromptScreen, promptEvidence } from "../src/agent-prompt.js";

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
