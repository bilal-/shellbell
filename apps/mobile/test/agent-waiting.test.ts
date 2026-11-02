import { describe, expect, it } from "vitest";
import { agentWaiting } from "../src/conversation/waiting";
import { blockedPrompt } from "../src/input/agentPrompt";
import { textScreen } from "../src/input/secretPrompt";

const menu = blockedPrompt(textScreen(["Do you want to proceed?", "❯ 1. Yes", "  2. No", ""], 3));
const plain = blockedPrompt(textScreen(["$ ls", "README.md", "$ "], 2));

describe("Chat waits for the owner", () => {
  it("when the computer reports the session blocked", () => {
    expect(agentWaiting({ sessionState: "blocked", prompt: plain, secret: false })).toEqual({
      question: null,
    });
    expect(agentWaiting({ sessionState: "blocked", prompt: null, secret: false })).toEqual({
      question: null,
    });
  });

  it("when the screen shows a menu or y/n prompt, with its proven question", () => {
    expect(agentWaiting({ sessionState: "running", prompt: menu, secret: false })).toEqual({
      question: "Do you want to proceed?",
    });
    const yesNo = blockedPrompt(textScreen(["Overwrite? [y/N] "], 0));
    expect(agentWaiting({ sessionState: "unknown", prompt: yesNo, secret: false })).toEqual({
      question: "Overwrite? [y/N]",
    });
  });

  it("never for an unknown or working state without evidence", () => {
    for (const sessionState of ["unknown", "running", "editing", "finished", undefined])
      expect(agentWaiting({ sessionState, prompt: plain, secret: false })).toBeNull();
  });

  it("leaves a password prompt to Secret input", () => {
    expect(agentWaiting({ sessionState: "blocked", prompt: menu, secret: true })).toBeNull();
  });
});
