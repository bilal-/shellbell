import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createGitContextReader,
  makeNotificationFacts,
  resolveNotificationContext,
} from "../src/notification-context.js";

const roots: string[] = [];
afterEach(() => {
  vi.useRealTimers();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
const facts = {
  sessionId: "tmux:1",
  revision: "1",
  locality: "local" as const,
  sessionLabel: "Tab 1 · Pane 1",
  title: "terminal",
  cwd: "/example",
};
const deps = { computerName: "MacBook", now: () => 1000, stillCurrent: () => true };

describe("private notification context", () => {
  it("keeps ordinary labels and slash-separated Git branches", async () => {
    const context = await resolveNotificationContext(facts, {
      ...deps,
      git: async () => ({ repository: "shellbell", branch: "fix/notifications" }),
    });
    expect(context.title).toBe("terminal");
    expect(context.branch).toBe("fix/notifications");
  });
  it.each([
    "/Users/alice/private-client",
    "remote-host:/home/alice/private-client",
    "shell — /home/alice/secret",
    "C:\\Users\\alice\\secret",
    "\\\\server\\private",
    "~/private-client",
    "https://git.example/private/repo.git",
    "git@git.example:private/repo.git",
  ])("omits path/origin-bearing display titles: %s", async (title) => {
    const context = await resolveNotificationContext(
      { ...facts, locality: "unknown", title, customName: title },
      { ...deps, git: async () => undefined },
    );
    expect(context.title).toBeUndefined();
    expect(context.customName).toBeUndefined();
    expect(context.sessionLabel).toBe(facts.sessionLabel);
  });
  it("distinguishes a local shell from guest or unproven path metadata", () => {
    const session = { sessionId: "x", sessionLabel: "Pane 1", cwd: "/example", title: "title" };
    expect(makeNotificationFacts(session, "zsh", "local-process")).toMatchObject({
      locality: "local",
      shell: "zsh",
    });
    expect(makeNotificationFacts(session, "ssh", "local-process")).toMatchObject({
      locality: "guest",
    });
    expect(makeNotificationFacts(session, "claude", "reported")).toMatchObject({
      locality: "unknown",
    });
    expect(makeNotificationFacts(session, "vim", "reported").shell).toBeUndefined();
  });
  it.each(["guest", "unknown"] as const)(
    "does not inspect host Git for %s paths",
    async (locality) => {
      const git = vi.fn(async () => ({ repository: "wrong" }));
      const context = await resolveNotificationContext({ ...facts, locality }, { ...deps, git });
      expect(context.repository).toBeUndefined();
      expect(context.title).toBe("terminal");
      expect(git).not.toHaveBeenCalled();
    },
  );

  it("drops a result whose session/cwd changed while Git was running", async () => {
    let current = true;
    const git = async () => {
      current = false;
      return { repository: "old-private-project" };
    };
    await expect(
      resolveNotificationContext(facts, { ...deps, git, stillCurrent: () => current }),
    ).rejects.toThrow("stale notification context");
  });

  it("falls back on unavailable Git and strips unsafe label controls", async () => {
    const result = await resolveNotificationContext(
      { ...facts, title: "hello\u001b\n\u202eworld" },
      {
        ...deps,
        git: async () => {
          throw new Error("private path never escapes");
        },
      },
    );
    expect(result.title).toBe("hello world");
    expect(result.repository).toBeUndefined();
  });

  it("bounds a hung lookup to 250ms without inventing a repo", async () => {
    vi.useFakeTimers();
    const pending = resolveNotificationContext(facts, {
      ...deps,
      git: () => new Promise(() => {}),
    });
    const assertion = expect(pending).resolves.toMatchObject({ title: "terminal" });
    await vi.advanceTimersByTimeAsync(250);
    await assertion;
  });

  it("reads a real repository, subdirectory, detached HEAD and worktree without user config", async () => {
    const root = mkdtempSync(join(tmpdir(), "shellbell-notify-repo-"));
    roots.push(root);
    const repo = join(root, "project");
    mkdirSync(repo);
    const git = (args: string[]) =>
      execFileSync("git", ["-C", repo, ...args], {
        env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" },
        stdio: "pipe",
      });
    git(["init", "-b", "main"]);
    git([
      "-c",
      "user.name=Fixture",
      "-c",
      "user.email=fixture@example.invalid",
      "-c",
      "commit.gpgsign=false",
      "commit",
      "--allow-empty",
      "-m",
      "fixture",
    ]);
    const sub = join(repo, "sub");
    mkdirSync(sub);
    expect(await createGitContextReader()(sub, new AbortController().signal)).toMatchObject({
      repository: "project",
      branch: "main",
    });
    const worktree = join(root, "other-worktree");
    git(["worktree", "add", "-b", "feature", worktree]);
    expect(await createGitContextReader()(worktree, new AbortController().signal)).toMatchObject({
      repository: "other-worktree",
      branch: "feature",
    });
    let now = 1_000;
    const cached = createGitContextReader({ now: () => now });
    expect(await cached(sub, new AbortController().signal)).toMatchObject({ branch: "main" });
    git(["checkout", "--detach"]);
    expect(await cached(sub, new AbortController().signal)).toMatchObject({
      branch: "main",
      observedAt: 1_000,
    });
    now = 6_000;
    expect(await cached(sub, new AbortController().signal)).toMatchObject({
      branch: "detached HEAD",
      observedAt: 6_000,
    });
    expect(await createGitContextReader()(sub, new AbortController().signal)).toMatchObject({
      repository: "project",
      branch: "detached HEAD",
    });
    const notRepo = join(root, "not-repo");
    mkdirSync(notRepo);
    expect(await createGitContextReader()(notRepo, new AbortController().signal)).toBeUndefined();
    writeFileSync(join(repo, "untouched"), "fixture");
  });
});
