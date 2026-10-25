import { describe, expect, it } from "vitest";
import {
  AGENT_HARNESSES,
  agentHarness,
  agentStyle,
  prefersConversation,
} from "../src/agents/registry";
import { agentName } from "../src/input/agentPrompt";

describe("agent harness registry", () => {
  it("opens Conversation first only for agents whose terminal keeps no history", () => {
    expect(prefersConversation("claude")).toBe(true);
    expect(prefersConversation("codex")).toBe(true);
    expect(prefersConversation("agy")).toBe(false);
    expect(prefersConversation("some-new-agent")).toBe(false);
    expect(prefersConversation(undefined)).toBe(false);
  });

  it("names and styles agents from one place", () => {
    expect(agentName("agy")).toBe("Antigravity");
    expect(agentName("claude")).toBe("Claude");
    expect(agentStyle("codex").prompt).toBe("›");
    expect(agentStyle("unknown")).toBe(AGENT_HARNESSES.claude!.style);
  });

  it("doesn't treat object built-ins as agents", () => {
    expect(agentHarness("constructor")).toBeUndefined();
    expect(agentHarness("__proto__")).toBeUndefined();
  });
});
