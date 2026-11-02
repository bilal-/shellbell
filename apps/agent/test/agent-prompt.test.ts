import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { Cursor, Line } from "@shellbell/protocol";
import { describe, expect, it } from "vitest";
import { promptEvidence } from "../src/conversation/agent-prompt.js";

/**
 * Screens and the evidence the phone's `promptEvidence(blockedPrompt(screen))` gave for them,
 * recorded from apps/mobile/src/input/agentPrompt.ts. The computer's port must agree.
 */
const vectors = JSON.parse(
  readFileSync(join(import.meta.dirname, "fixtures/agent-prompt-vectors.json"), "utf8"),
) as { name: string; screen: { cursor: Cursor; lines: Line[] }; evidence: string | null }[];

describe("agent prompt evidence on the computer", () => {
  it.each(vectors)("agrees with the phone on $name", ({ screen, evidence }) => {
    expect(promptEvidence(screen)).toBe(evidence);
  });
  it("covers menus, y/n prompts and screens that are neither", () => {
    expect(new Set(vectors.map((vector) => vector.evidence))).toEqual(
      new Set(["menu", "yes-no", null]),
    );
  });
  it("says nothing for no screen", () => {
    expect(promptEvidence(undefined)).toBeNull();
  });
});
