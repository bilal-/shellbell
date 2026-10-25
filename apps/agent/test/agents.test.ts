import { describe, expect, it } from "vitest";
import { AGENTS, canonicalAgent } from "../src/agents.js";
import { agentKind, detectAgent } from "../src/session-naming.js";

describe("agent recognition", () => {
  it.each([
    ["claude", "claude"],
    ["/usr/local/bin/claude", "claude"],
    ["Claude-Code", "claude"],
    ["agy", "agy"],
    ["antigravity", "agy"],
    ["cursor-agent", "cursor"],
    ["cursor-agent.cmd", "cursor"],
    ["gemini", "gemini"],
    ["ghcs", "copilot"],
    ["kiro-cli", "kiro"],
    ["muse-bin-0.1.0-R708.1", "muse"],
  ])("knows %s as %s", (name, kind) => {
    expect(canonicalAgent(name)).toBe(kind);
    expect(detectAgent(name, undefined)).toBe(kind);
  });

  it.each(["zsh", "node", "vim", "muse-binary", "muse-bin", "", "pi-hole"])(
    "doesn't take %j for an agent",
    (name) => expect(canonicalAgent(name)).toBeUndefined(),
  );

  it("gives Herdr's labels the same kinds as process names", () => {
    expect(agentKind("agy")).toBe("agy");
    expect(agentKind("copilot")).toBe("copilot");
    // An agent Shellbell doesn't know still gets a clean, bounded label.
    expect(agentKind("SomeNewAgent")).toBe("somenewagent");
  });

  it("maps each name to exactly one agent", () => {
    const names = Object.values(AGENTS).flat();
    expect(new Set(names).size).toBe(names.length);
  });
});
