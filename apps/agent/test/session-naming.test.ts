import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { encodeCbor, MAX_TERMINAL_MESSAGE_BYTES, type SessionInfo } from "@shellbell/protocol";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createGitContextReader, type GitContextReader } from "../src/notification-context.js";
import {
  agentKind,
  detectAgent,
  fitSessionList,
  herdrNaming,
  localProjectCommand,
  manualWindowName,
  nameSession,
  ProjectNames,
  projectFromCwd,
  stripStatusGlyphs,
} from "../src/session-naming.js";

/** Sanitised shapes of real `herdr api snapshot` panes (herdr 0.9.3). */
const HERDR_CLAUDE = {
  agent: "claude",
  agent_status: "working",
  cwd: "/Users/example/code/shellbell",
  foreground_cwd: "/Users/example/code/shellbell",
  label: "Relay security for mobile and laptop",
  terminal_title: "◑ Relay security for mobile and laptop",
  terminal_title_stripped: "Relay security for mobile and laptop",
};
const HERDR_CODEX = {
  agent: "codex",
  agent_status: "working",
  cwd: "/Users/example/code/webBooks",
  foreground_cwd: "/Users/example/code/webBooks",
  label: "Clean up stale worktrees | webBooks",
  terminal_title: "⠇ Clean up stale worktrees | webBooks",
  terminal_title_stripped: "Clean up stale worktrees | webBooks",
};
const HERDR_SHELL = {
  agent_status: "unknown",
  cwd: "/Users/example/code/notes",
  terminal_title_stripped: "zsh",
};

describe("status glyphs", () => {
  it.each([
    ["⠸ Review uncommitted repo files", "Review uncommitted repo files"],
    ["⠂⠐ Two spinner frames", "Two spinner frames"],
    ["✳ Approved branch plan resumption", "Approved branch plan resumption"],
    ["✶ Thinking", "Thinking"],
    ["✻ Thinking", "Thinking"],
    ["✽ Thinking", "Thinking"],
    ["✢ Thinking", "Thinking"],
    ["◐ Working", "Working"],
    ["◓ Working", "Working"],
    ["◑ Working", "Working"],
    ["◒ Working", "Working"],
    ["· Waiting", "Waiting"],
    ["* Done", "Done"],
    ["  ✳  Spaced out", "Spaced out"],
  ])("strips the leading status run of %j", (title, task) => {
    expect(stripStatusGlyphs(title)).toBe(task);
  });
  it.each(["plain title", "*emphasis", "✳", "Review ✳ later", ""])("leaves %j", (title) => {
    expect(stripStatusGlyphs(title)).toBe(title.trim());
  });
});

describe("agent kinds", () => {
  it.each([
    ["claude", "claude"],
    ["claude-code", "claude"],
    ["Claude Code", "claude"],
    ["codex", "codex"],
    ["Codex", "codex"],
    ["gemini", "gemini"],
  ])("normalises %j", (raw, kind) => {
    expect(agentKind(raw)).toBe(kind);
  });
  it("bounds and cleans an unknown kind", () => {
    expect(agentKind(`a\u0007${"b".repeat(80)}`)?.length).toBe(32);
    expect(agentKind("")).toBeUndefined();
    expect(agentKind("/usr/bin/thing")).toBeUndefined();
  });

  it.each([
    ["claude", "anything", "claude"],
    ["/opt/homebrew/bin/codex", "", "codex"],
    ["node", "✳ Fix flaky test", "claude"],
    ["2.1.3", "⠂ Fix flaky test", "claude"],
    ["node", "⠸ Review files | repo", "codex"],
    [undefined, "✶ Fix flaky test", "claude"],
  ])("detects %j with title %j as %j", (processName, title, kind) => {
    expect(detectAgent(processName, title)).toBe(kind);
  });
  it.each([
    ["zsh", "✳ Fix flaky test"],
    ["vim", "✳ notes"],
    ["node", "server listening"],
    ["2.1.3", "plain"],
    [undefined, "plain"],
  ])("does not guess an agent for %j with title %j", (processName, title) => {
    expect(detectAgent(processName, title)).toBeUndefined();
  });
});

describe("projects", () => {
  it("uses the folder name, home as ~, and nothing for the root", () => {
    expect(projectFromCwd("/Users/example/code/shellbell", "/Users/example")).toBe("shellbell");
    expect(projectFromCwd("/Users/example/code/shellbell/", "/Users/example")).toBe("shellbell");
    expect(projectFromCwd("/Users/example", "/Users/example")).toBe("~");
    expect(projectFromCwd("C:\\Users\\example\\repo", "/Users/example")).toBe("repo");
    expect(projectFromCwd("/", "/Users/example")).toBeUndefined();
    expect(projectFromCwd(undefined, "/Users/example")).toBeUndefined();
    expect(projectFromCwd(`/x/${"p".repeat(300)}`, "/h")).toHaveLength(128);
  });

  it.each([
    ["api", "zsh", "api"],
    ["api server", "node", "api server"],
    ["zsh", "zsh", undefined],
    ["bash", "claude", undefined],
    ["claude", "2.1.3", undefined],
    ["2.1.3", "2.1.3", undefined],
    ["2.1.14", "zsh", undefined],
    ["node", "claude", undefined],
    ["[tmux]", "zsh", undefined],
    ["zsh[dead]", "zsh", undefined],
    ["", "zsh", undefined],
  ])("treats tmux window %j running %j as manual name %j", (windowName, command, manual) => {
    expect(manualWindowName(windowName, command)).toBe(manual);
  });

  it.each([
    ["zsh", true],
    ["-zsh", true],
    ["claude", true],
    ["codex", true],
    ["node", true],
    ["2.1.3", true],
    ["ssh", false],
    ["mosh", false],
    ["docker", false],
    ["vim", false],
    [undefined, false],
  ])("treats a cwd under %j as local: %j", (command, local) => {
    expect(localProjectCommand(command)).toBe(local);
  });
});

describe("herdr naming", () => {
  it("names a herdr claude pane after its workspace and task", () => {
    expect(herdrNaming(HERDR_CLAUDE, "shellbell")).toEqual({
      project: "shellbell",
      agent: { kind: "claude", task: "Relay security for mobile and laptop" },
    });
  });

  it("removes codex's trailing project from the task", () => {
    expect(herdrNaming(HERDR_CODEX, "webBooks")).toEqual({
      project: "webBooks",
      agent: { kind: "codex", task: "Clean up stale worktrees" },
    });
    // Without a workspace label the folder name is the project, and the suffix still goes.
    expect(herdrNaming(HERDR_CODEX, undefined)).toEqual({
      project: "webBooks",
      agent: { kind: "codex", task: "Clean up stale worktrees" },
    });
  });

  it("falls back to the stripped terminal title, then the raw title without its glyph", () => {
    expect(herdrNaming({ ...HERDR_CLAUDE, label: undefined }, "shellbell").agent).toEqual({
      kind: "claude",
      task: "Relay security for mobile and laptop",
    });
    expect(
      herdrNaming(
        { ...HERDR_CLAUDE, label: undefined, terminal_title_stripped: undefined },
        "shellbell",
      ).agent,
    ).toEqual({ kind: "claude", task: "Relay security for mobile and laptop" });
  });

  it("keeps the agent but drops a task that only repeats its name", () => {
    expect(
      herdrNaming(
        {
          agent: "claude-code",
          display_agent: "Claude Code",
          terminal_title_stripped: "claude",
          cwd: "/Users/example/code/shellbell",
        },
        "shellbell",
      ),
    ).toEqual({ project: "shellbell", agent: { kind: "claude" } });
    expect(herdrNaming({ ...HERDR_CLAUDE, label: "Claude Code" }, "x").agent).toEqual({
      kind: "claude",
    });
  });

  it("has no agent for a shell pane and uses the workspace, else the folder, as project", () => {
    expect(herdrNaming(HERDR_SHELL, "notes-ws")).toEqual({ project: "notes-ws" });
    expect(herdrNaming(HERDR_SHELL, undefined)).toEqual({ project: "notes" });
    expect(herdrNaming(HERDR_SHELL, "")).toEqual({ project: "notes" });
  });

  it("omits path-like and control-character task text rather than displaying it", () => {
    expect(herdrNaming({ ...HERDR_CLAUDE, label: "/Users/example/private" }, "s").agent).toEqual({
      kind: "claude",
    });
    expect(herdrNaming({ ...HERDR_CLAUDE, label: "ssh://host/x" }, "s").agent).toEqual({
      kind: "claude",
    });
    expect(herdrNaming({ ...HERDR_CLAUDE, label: "Fix\u001b[31m bug\n now" }, "s").agent).toEqual({
      kind: "claude",
      task: "Fix[31m bug now",
    });
    const long = herdrNaming({ ...HERDR_CLAUDE, label: "é".repeat(300) }, "s").agent?.task;
    expect(Buffer.byteLength(long ?? "", "utf8")).toBeLessThanOrEqual(256);
    expect(long?.length).toBe(128);
  });
});

describe("terminal naming", () => {
  it("names a tmux claude pane from its title with the glyph removed", () => {
    expect(
      nameSession({
        cwd: "/Users/example/code/shellbell/apps/agent",
        processName: "2.1.3",
        title: "✳ Relay security for mobile and laptop",
      }),
    ).toEqual({
      project: "agent",
      agent: { kind: "claude", task: "Relay security for mobile and laptop" },
    });
  });

  it("removes codex's trailing repository even when it differs from the folder", () => {
    expect(
      nameSession({
        cwd: "/Users/example/code/webBooks/src",
        processName: "codex",
        title: "⠇ Clean up stale worktrees | webBooks",
      }).agent,
    ).toEqual({ kind: "codex", task: "Clean up stale worktrees" });
  });

  it("keeps a pipe in a non-codex task unless it names the project", () => {
    expect(
      nameSession({ cwd: "/r/shellbell", processName: "claude", title: "✳ Compare a | b" }).agent,
    ).toEqual({ kind: "claude", task: "Compare a | b" });
    expect(
      nameSession({ cwd: "/r/shellbell", processName: "claude", title: "✳ Fix it | shellbell" })
        .agent,
    ).toEqual({ kind: "claude", task: "Fix it" });
  });

  it("gives a shell pane only a project, and a manual name wins over the folder", () => {
    expect(nameSession({ cwd: "/r/shellbell", processName: "zsh", title: "example-host" })).toEqual(
      { project: "shellbell" },
    );
    expect(
      nameSession({ cwd: "/r/shellbell", project: "api", processName: "zsh", title: "x" }),
    ).toEqual({ project: "api" });
  });

  it("ignores a task equal to an ignored default title such as the host name", () => {
    expect(
      nameSession({
        cwd: "/r/shellbell",
        processName: "claude",
        title: "example-host",
        ignore: ["example-host"],
      }),
    ).toEqual({ project: "shellbell", agent: { kind: "claude" } });
  });

  it("removes iTerm2's trailing job name from a session name", () => {
    expect(
      nameSession({ cwd: "/r/shellbell", processName: "claude", title: "✳ Fix it (claude)" }).agent,
    ).toEqual({ kind: "claude", task: "Fix it" });
  });
});

describe("git project names", () => {
  const roots: string[] = [];
  afterEach(() => {
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  });

  function fakeGit(answers: Record<string, string | undefined>) {
    const calls: string[] = [];
    const pending: (() => void)[] = [];
    const git: GitContextReader = (cwd) => {
      calls.push(cwd);
      return new Promise((resolve) => {
        pending.push(() => {
          const repository = answers[cwd];
          resolve(repository ? { repository } : undefined);
        });
      });
    };
    const settle = async () => {
      for (const done of pending.splice(0)) done();
      await new Promise((r) => setImmediate(r));
    };
    return { git, calls, settle };
  }

  it("answers from cache, looks up once, and reports a newly known repository", async () => {
    const { git, calls, settle } = fakeGit({ "/r/shellbell/apps/agent": "shellbell" });
    const onChange = vi.fn();
    const names = new ProjectNames(git, onChange, () => 1000);
    expect(names.lookup("/r/shellbell/apps/agent")).toBeUndefined();
    expect(names.lookup("/r/shellbell/apps/agent")).toBeUndefined();
    expect(calls).toEqual(["/r/shellbell/apps/agent"]);
    await settle();
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(names.lookup("/r/shellbell/apps/agent")).toBe("shellbell");
    expect(calls).toHaveLength(1);
  });

  it("does not announce a folder that is not in a repository", async () => {
    const { git, settle } = fakeGit({});
    const onChange = vi.fn();
    const names = new ProjectNames(git, onChange, () => 1000);
    expect(names.lookup("/tmp/scratch")).toBeUndefined();
    await settle();
    expect(names.lookup("/tmp/scratch")).toBeUndefined();
    expect(onChange).not.toHaveBeenCalled();
  });

  it("keeps a stale answer while revalidating and announces only a real change", async () => {
    let now = 1000;
    const answers: Record<string, string | undefined> = { "/r/a": "first" };
    const { git, calls, settle } = fakeGit(answers);
    const onChange = vi.fn();
    const names = new ProjectNames(git, onChange, () => now);
    names.lookup("/r/a");
    await settle();
    now += 60_000;
    expect(names.lookup("/r/a")).toBe("first");
    expect(calls).toHaveLength(2);
    await settle();
    expect(onChange).toHaveBeenCalledTimes(1);
    answers["/r/a"] = "second";
    now += 60_000;
    names.lookup("/r/a");
    await settle();
    expect(onChange).toHaveBeenCalledTimes(2);
    expect(names.lookup("/r/a")).toBe("second");
  });

  it("bounds concurrent lookups and remembered folders", async () => {
    const { git, calls, settle } = fakeGit({});
    const names = new ProjectNames(
      git,
      () => {},
      () => 1000,
    );
    for (let i = 0; i < 40; i++) names.lookup(`/r/${i}`);
    expect(calls.length).toBeLessThanOrEqual(16);
    await settle();
    for (let i = 0; i < 600; i++) {
      names.lookup(`/s/${i}`);
      await settle();
    }
    expect(names.size).toBeLessThanOrEqual(256);
  });

  it("does not run git for a relative or over-long folder", () => {
    const { git, calls } = fakeGit({});
    const names = new ProjectNames(
      git,
      () => {},
      () => 1000,
    );
    names.lookup("relative/path");
    names.lookup(`/${"x".repeat(1100)}`);
    expect(calls).toEqual([]);
  });

  it("names a subdirectory after its real git top level", async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "shellbell-naming-")));
    roots.push(root);
    const repo = join(root, "myrepo");
    mkdirSync(join(repo, "apps", "agent"), { recursive: true });
    execFileSync("git", ["init", "-q", repo]);
    let changed!: () => void;
    const seen = new Promise<void>((resolve) => {
      changed = resolve;
    });
    const names = new ProjectNames(createGitContextReader(), () => changed());
    expect(names.lookup(join(repo, "apps", "agent"))).toBeUndefined();
    await seen;
    expect(names.lookup(join(repo, "apps", "agent"))).toBe("myrepo");
  });
});

describe("fitSessionList", () => {
  const session = (i: number): SessionInfo => ({
    id: `tmux:%${i}`,
    backend: "tmux",
    title: `${i} ${"x".repeat(230)}`,
    cwd: `/Users/me/src/project-${i}`,
    cols: 80,
    rows: 24,
    windowId: `tmux:@${i}`,
    windowNumber: i,
    tabId: `tmux:@${i}`,
    tabIndex: 0,
    paneIndex: 0,
    isFocusedOnMac: false,
    state: "running",
    project: "p".repeat(80),
    agent: { kind: "claude", task: "t".repeat(234) },
  });

  it("sends a short list unchanged", () => {
    const list = [session(1), session(2)];
    expect(fitSessionList(list).list).toBe(list);
    expect(fitSessionList(list).complete).toBe(true);
  });

  it("says a list is complete only while it still names every session's agent", () => {
    const list = Array.from({ length: 80 }, (_, i) => ({
      ...session(i),
      agent: { kind: "claude", task: "t".repeat(234), reportsState: true as const },
      stateSince: 1,
      activeAt: 2,
    }));
    // Shedding task text and times keeps every agent, and whether it reports its state.
    const tasks = fitSessionList(list);
    expect(tasks.complete).toBe(true);
    expect(tasks.list[0]?.agent).toEqual({ kind: "claude", reportsState: true });
    expect(tasks.list[0]).not.toHaveProperty("stateSince");
    // Dropping agents, or sessions, leaves a list that may be missing some.
    expect(fitSessionList(list, 38_000).complete).toBe(false);
    expect(fitSessionList(Array.from({ length: 500 }, (_, i) => session(i))).complete).toBe(false);
  });

  it("counts the completeness marker within the message limit", () => {
    const many = Array.from({ length: 500 }, (_, i) => session(i));
    for (const limit of [20_000, 38_000, MAX_TERMINAL_MESSAGE_BYTES])
      expect(encodeCbor(fitSessionList(many, limit)).length).toBeLessThanOrEqual(limit);
    // A list that exactly fills the limit without the marker doesn't fit with it.
    const list = [session(1), session(2)];
    const exact = encodeCbor({ type: "sessions", list }).length;
    const fitted = fitSessionList(list, exact);
    expect(encodeCbor(fitted).length).toBeLessThanOrEqual(exact);
    expect(fitted.complete).toBe(true);
  });

  it("drops task text, then other names, so a long list still fits one message", () => {
    const list = Array.from({ length: 80 }, (_, i) => session(i));
    expect(encodeCbor({ type: "sessions", list }).length).toBeGreaterThan(
      MAX_TERMINAL_MESSAGE_BYTES,
    );
    const fitted = fitSessionList(list);
    expect(encodeCbor(fitted).length).toBeLessThanOrEqual(MAX_TERMINAL_MESSAGE_BYTES);
    expect(fitted.list).toHaveLength(80);
    expect(fitted.list[0]).toMatchObject({
      title: `0 ${"x".repeat(230)}`,
      project: "p".repeat(80),
    });
    expect(fitted.list[0]?.agent).toEqual({ kind: "claude" });

    const paths = Array.from({ length: 80 }, (_, i) => ({
      ...session(i),
      title: `${i} ${"é".repeat(254)}`,
      cwd: `/${"d".repeat(399)}`,
    }));
    const shed = fitSessionList(paths);
    expect(encodeCbor(shed).length).toBeLessThanOrEqual(MAX_TERMINAL_MESSAGE_BYTES);
    expect(shed.list).toHaveLength(80);
    expect(shed.list[0]).not.toHaveProperty("cwd");

    const many = Array.from({ length: 500 }, (_, i) => session(i));
    const kept = fitSessionList(many);
    expect(encodeCbor(kept).length).toBeLessThanOrEqual(MAX_TERMINAL_MESSAGE_BYTES);
    expect(kept.list.length).toBeGreaterThan(0);
    expect(kept.list[0]?.id).toBe("tmux:%0");

    const tight = fitSessionList(list, 38_000);
    expect(encodeCbor(tight).length).toBeLessThanOrEqual(38_000);
    expect(tight.list[0]).not.toHaveProperty("project");
    expect(tight.list[0]).not.toHaveProperty("agent");
  });
});

describe("Gemini CLI", () => {
  it("is named by its titles when it runs as node, with no task", () => {
    for (const title of [
      "Gemini CLI (orbit)".padEnd(80, " "),
      "◇  Ready (orbit)",
      "✋  Action Required (orbit)",
      "⏲  Working… (orbit)",
    ]) {
      expect(detectAgent("node", title), title).toBe("gemini");
      expect(nameSession({ cwd: "/x/orbit", processName: "node", title }).agent).toEqual({
        kind: "gemini",
      });
    }
    // Only for node: a shell whose title happens to look like this is not Gemini.
    expect(detectAgent("zsh", "◇  Ready (orbit)")).toBeUndefined();
    expect(detectAgent("node", "Ready (orbit)")).toBeUndefined();
  });
});

describe("Pi", () => {
  it("shows no task for its default title, only a session name the owner chose", () => {
    const pane = (label: string) =>
      herdrNaming({ agent: "pi", label, cwd: "/Users/x/workspace/orchid" }, "orchid");
    expect(pane("π - orchid").agent).toEqual({ kind: "pi" });
    expect(pane("π - Fix the parser - orchid").agent).toEqual({
      kind: "pi",
      task: "Fix the parser",
    });
  });
});
