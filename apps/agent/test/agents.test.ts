import { readFileSync } from "node:fs";
import { join } from "node:path";
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

describe("manual tmux window names", () => {
  it("keeps a window the owner named after a short word that is also an agent", async () => {
    const { manualWindowName } = await import("../src/session-naming.js");
    for (const name of ["amp", "pi", "hermes", "droid", "muse"])
      expect(manualWindowName(name, "zsh")).toBe(name);
    // tmux's own automatic name for a running agent is still not manual.
    expect(manualWindowName("amp", "amp")).toBeUndefined();
    expect(manualWindowName("claude", "zsh")).toBeUndefined();
  });
});

describe("agent knowledge used for naming", () => {
  it("treats any known agent in the foreground as a local project command", async () => {
    const { localProjectCommand } = await import("../src/session-naming.js");
    for (const command of ["claude", "codex", "agy", "gemini", "cursor-agent"])
      expect(localProjectCommand(command), command).toBe(true);
    expect(localProjectCommand("vim")).toBe(false);
  });

  it("doesn't take an agent's own name for its task", async () => {
    const { nameSession } = await import("../src/session-naming.js");
    for (const [command, title] of [
      ["agy", "antigravity"],
      ["gemini", "⠋ gemini"],
      ["claude", "✳ Claude Code"],
    ])
      expect(nameSession({ processName: command, title }).agent?.task, command).toBeUndefined();
  });

  it("names the same agents the phone has a badge and name for", () => {
    const registry = readFileSync(
      join(import.meta.dirname, "../../mobile/src/agents/registry.ts"),
      "utf8",
    );
    const body = registry.slice(registry.indexOf("AGENT_HARNESSES"));
    const keys = [...body.matchAll(/^ {2}([a-z]+): \{/gm)].map((match) => match[1]);
    expect(new Set(keys)).toEqual(new Set(Object.keys(AGENTS)));
  });
});
