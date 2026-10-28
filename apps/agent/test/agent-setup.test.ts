import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  agentSetupLine,
  agentSetupPaths,
  agentsToOffer,
  detectAgents,
  removeAgentSetup,
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
  mkdirSync(join(home, ".shellbell"), { mode: 0o700 });
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
  mkdirSync(state, { mode: 0o700 });
  refreshAgentHooks(where());
  expect(existsSync(join(state, "codex-session-hook.sh"))).toBe(false);
  writeFileSync(join(state, "codex-session-hook.sh"), "#!/bin/sh\nhead -c 65536\n");
  refreshAgentHooks(where());
  const script = readFileSync(join(state, "codex-session-hook.sh"), "utf8");
  expect(script).toContain("shellbell-agent-hook 2");
  expect(script).not.toContain("head -c 65536\n}");
});

describe("Gemini setup", () => {
  const settings = () => join(home, ".gemini", "settings.json");
  const read = () => JSON.parse(readFileSync(settings(), "utf8"));
  const gemini = (contents?: string) => {
    mkdirSync(join(home, ".gemini", "tmp"), { recursive: true });
    if (contents !== undefined) writeFileSync(settings(), contents);
  };
  const other = { hooks: [{ type: "command", name: "mine", command: "echo hi" }] };

  it("is offered only when Gemini CLI itself is installed", () => {
    mkdirSync(join(home, ".gemini", "antigravity-cli"), { recursive: true });
    expect(detectAgents(where()).map((a) => a.kind)).toEqual(["agy"]);
    gemini();
    expect(detectAgents(where()).find((a) => a.kind === "gemini")?.state).toBe("needs-setup");
  });

  it("adds its hook beside others, once, and removes only its own", () => {
    gemini(JSON.stringify({ security: { auth: "x" }, hooks: { SessionStart: [other] } }));
    setupAgents(where(), ["gemini"]);
    setupAgents(where(), ["gemini"]);
    const added = read();
    expect(added.security).toEqual({ auth: "x" });
    expect(added.hooks.SessionStart).toHaveLength(2);
    expect(added.hooks.SessionStart[0]).toEqual(other);
    expect(added.hooks.BeforeAgent).toHaveLength(1);
    expect(added.hooks.BeforeAgent[0].hooks[0]).toMatchObject({
      name: "shellbell-session",
      command: expect.stringContaining("gemini-session-hook.sh"),
    });
    expect(detectAgents(where()).find((a) => a.kind === "gemini")?.state).toBe("ready");
    removeAgentSetup(where(), "gemini");
    expect(read()).toEqual({ security: { auth: "x" }, hooks: { SessionStart: [other] } });
  });

  it("never rewrites a settings file with comments, and leaves hooks the owner turned off", () => {
    const commented = '{\n  // mine\n  "security": {}\n}\n';
    gemini(commented);
    expect(setupAgents(where(), ["gemini"]).find((a) => a.kind === "gemini")?.state).toBe(
      "blocked",
    );
    expect(readFileSync(settings(), "utf8")).toBe(commented);
    writeFileSync(settings(), JSON.stringify({ hooksConfig: { enabled: false } }));
    expect(setupAgents(where(), ["gemini"]).find((a) => a.kind === "gemini")?.state).toBe(
      "hooks-off",
    );
    expect(read()).toEqual({ hooksConfig: { enabled: false } });
  });
});

describe("on a computer where Shellbell has never run", () => {
  it("creates its private state folder the way the service requires, for set up and skip", () => {
    mkdirSync(join(home, ".codex"));
    const state = join(home, ".shellbell");
    skipAgentSetup(where(), ["codex"]);
    expect(statSync(state).mode & 0o777).toBe(0o700);
    rmSync(state, { recursive: true });
    setupAgents(where(), ["codex"]);
    expect(statSync(state).mode & 0o777).toBe(0o700);
  });
});

it("edits a settings file kept as a symlink, such as in a dotfiles repo, through the link", () => {
  const dotfiles = join(home, "dotfiles");
  mkdirSync(dotfiles);
  mkdirSync(join(home, ".gemini", "tmp"), { recursive: true });
  writeFileSync(join(dotfiles, "settings.json"), "{}");
  symlinkSync(join(dotfiles, "settings.json"), join(home, ".gemini", "settings.json"));
  setupAgents(where(), ["gemini"]);
  expect(lstatSync(join(home, ".gemini", "settings.json")).isSymbolicLink()).toBe(true);
  expect(readFileSync(join(dotfiles, "settings.json"), "utf8")).toContain("shellbell-session");
});

describe("on Linux", () => {
  it("keeps every setup file beside the state folder, which host admission owns", () => {
    mkdirSync(join(home, ".codex"));
    mkdirSync(join(home, ".gemini", "tmp"), { recursive: true });
    const state = join(home, "state", "hosts", "scope");
    const linux = agentSetupPaths(state, home, "linux");
    skipAgentSetup(linux, ["codex"]);
    setupAgents(linux);
    // Host initialization requires an absent or initialized state folder; setup creates neither.
    expect(existsSync(state)).toBe(false);
    const helpers = `${state}-agents`;
    expect(statSync(helpers).mode & 0o777).toBe(0o700);
    expect(existsSync(join(helpers, "codex-session-hook.sh"))).toBe(true);
    expect(existsSync(join(helpers, "gemini-session-hook.sh"))).toBe(true);
    expect(readFileSync(join(home, ".codex", "hooks.json"), "utf8")).toContain(helpers);
  });
});

it("refuses a helper folder that isn't this user's private folder", () => {
  mkdirSync(join(home, ".codex"));
  const state = join(home, "shared", "state");
  const linux = agentSetupPaths(state, home, "linux");
  // Someone else made it first, open to others, as could happen under /tmp.
  mkdirSync(`${state}-agents`, { recursive: true, mode: 0o777 });
  chmodSync(`${state}-agents`, 0o777);
  expect(() => setupAgents(linux)).toThrow(/isn't a private folder/);
  expect(existsSync(join(`${state}-agents`, "codex-session-hook.sh"))).toBe(false);
  expect(existsSync(join(home, ".codex", "hooks.json"))).toBe(false);
});

it("neither refreshes nor removes helpers in a folder that isn't private", async () => {
  const { refreshAgentHooks } = await import("../src/agent-setup.js");
  mkdirSync(join(home, ".codex"));
  const state = join(home, "shared", "state");
  const linux = agentSetupPaths(state, home, "linux");
  setupAgents(linux, ["codex"]);
  const script = join(`${state}-agents`, "codex-session-hook.sh");
  const hooks = readFileSync(join(home, ".codex", "hooks.json"), "utf8");
  chmodSync(`${state}-agents`, 0o777);
  writeFileSync(script, "old");
  refreshAgentHooks(linux);
  expect(readFileSync(script, "utf8")).toBe("old");
  expect(() => removeAgentSetup(linux, "codex")).toThrow(/isn't a private folder/);
  expect(readFileSync(join(home, ".codex", "hooks.json"), "utf8")).toBe(hooks);
  chmodSync(`${state}-agents`, 0o700);
});
