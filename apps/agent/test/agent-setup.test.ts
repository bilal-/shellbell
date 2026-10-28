import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  agentSetupLine,
  agentSetupPaths,
  agentsToOffer,
  detectAgents,
  setupAgents,
  skipAgentSetup,
} from "../src/agent-setup.js";

let home: string;
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "sb-agent-setup-"));
  vi.stubEnv("CODEX_HOME", "");
  vi.stubEnv("CLAUDE_CONFIG_DIR", "");
});
afterEach(() => {
  vi.unstubAllEnvs();
  rmSync(home, { recursive: true, force: true });
});
const where = () => agentSetupPaths(join(home, ".shellbell"), home);

it("finds only the agents whose folders exist, full-history agents first", () => {
  expect(detectAgents(where())).toEqual([]);
  mkdirSync(join(home, ".qwen"));
  mkdirSync(join(home, ".codex"));
  mkdirSync(join(home, ".gemini", "antigravity-cli"), { recursive: true });
  expect(detectAgents(where()).map((a) => [a.kind, a.state])).toEqual([
    ["codex", "needs-setup"],
    ["agy", "ready"],
    ["qwen", "coming-soon"],
  ]);
});

it("offers set up until it is done or skipped, and setting up clears a skip", () => {
  mkdirSync(join(home, ".codex"));
  mkdirSync(join(home, ".shellbell"));
  expect(agentsToOffer(detectAgents(where())).map((a) => a.kind)).toEqual(["codex"]);
  expect(agentsToOffer(skipAgentSetup(where(), ["codex"]))).toEqual([]);
  const done = setupAgents(where());
  expect(done.find((a) => a.kind === "codex")).toMatchObject({ state: "ready", skipped: false });
  expect(agentsToOffer(done)).toEqual([]);
});

it("explains a Codex config it won't edit instead of changing it", () => {
  mkdirSync(join(home, ".codex"));
  writeFileSync(join(home, ".codex", "config.toml"), "features = { hooks = true }\n");
  const [codex] = setupAgents(where());
  expect(codex).toMatchObject({ kind: "codex", state: "blocked" });
  expect(agentSetupLine(codex!)).toContain("hooks = true");
});

it("doctor warns about agents that still need setup, without failing", async () => {
  const { agentsCheck } = await import("../src/doctor.js");
  mkdirSync(join(home, ".codex"));
  expect(agentsCheck(join(home, ".shellbell"), home)).toMatchObject({
    ok: true,
    severity: "warning",
    fix: "run shellbell agents setup",
  });
  setupAgents(where());
  expect(agentsCheck(join(home, ".shellbell"), home)).toMatchObject({
    severity: "pass",
    detail: "full history ready for Codex",
  });
});

it("updates only a helper script Shellbell already installed", async () => {
  const { refreshAgentHooks } = await import("../src/agent-setup.js");
  const state = join(home, ".shellbell");
  mkdirSync(state);
  refreshAgentHooks(where());
  expect(existsSync(join(state, "codex-session-hook.sh"))).toBe(false);
  writeFileSync(join(state, "codex-session-hook.sh"), "#!/bin/sh\nhead -c 65536\n");
  refreshAgentHooks(where());
  const script = readFileSync(join(state, "codex-session-hook.sh"), "utf8");
  expect(script).toContain("shellbell-agent-hook 2");
  expect(script).not.toContain("head -c 65536\n}");
});
