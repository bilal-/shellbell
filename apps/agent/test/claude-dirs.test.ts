import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { CLAUDE_CONFIG_DIRS, claudeFolders } from "../src/conversation/claude-dirs.js";

const homes: string[] = [];
afterEach(() => {
  for (const dir of homes.splice(0)) rmSync(dir, { recursive: true, force: true });
});
function home(): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "shellbell-home-")));
  homes.push(dir);
  return dir;
}

describe("Claude Code config folders", () => {
  it("finds profile folders beside ~/.claude that Claude has used", () => {
    const at = home();
    mkdirSync(join(at, ".claude-ph", "projects"), { recursive: true });
    mkdirSync(join(at, ".claude.work", "sessions"), { recursive: true });
    // Not profiles: no projects or sessions, a file, and an unrelated name.
    mkdirSync(join(at, ".claude-empty"));
    writeFileSync(join(at, ".claude.json"), "{}");
    mkdirSync(join(at, ".claudette", "projects"), { recursive: true });
    expect(claudeFolders(at, {})).toEqual({
      projects: [join(at, ".claude", "projects"), join(at, ".claude-ph", "projects")],
      sessions: [join(at, ".claude", "sessions"), join(at, ".claude.work", "sessions")],
    });
  });

  it("never follows a link from a found profile", () => {
    const at = home();
    const elsewhere = join(at, "elsewhere");
    mkdirSync(join(elsewhere, "projects"), { recursive: true });
    mkdirSync(join(at, ".claude-work", "sessions"), { recursive: true });
    symlinkSync(join(elsewhere, "projects"), join(at, ".claude-work", "projects"));
    symlinkSync(elsewhere, join(at, ".claude-linked"));
    expect(claudeFolders(at, {})).toEqual({
      projects: [join(at, ".claude", "projects")],
      sessions: [join(at, ".claude", "sessions"), join(at, ".claude-work", "sessions")],
    });
  });

  it("puts the service's own CLAUDE_CONFIG_DIR first, once", () => {
    const at = home();
    mkdirSync(join(at, ".claude-ph", "projects"), { recursive: true });
    expect(claudeFolders(at, { CLAUDE_CONFIG_DIR: join(at, ".claude-ph") }).projects).toEqual([
      join(at, ".claude-ph", "projects"),
      join(at, ".claude", "projects"),
    ]);
  });

  it("counts a folder named with a trailing slash once", () => {
    const at = home();
    mkdirSync(join(at, ".claude-work", "sessions"), { recursive: true });
    expect(
      claudeFolders(at, { CLAUDE_CONFIG_DIR: `${join(at, ".claude-work")}/` }).sessions,
    ).toEqual([join(at, ".claude-work", "sessions"), join(at, ".claude", "sessions")]);
  });

  it("stops at the number of folders the transcript readers accept", () => {
    const at = home();
    for (let i = 0; i < 12; i++)
      mkdirSync(join(at, `.claude-p${i}`, "projects"), { recursive: true });
    expect(claudeFolders(at, {}).projects).toHaveLength(CLAUDE_CONFIG_DIRS);
  });
});
