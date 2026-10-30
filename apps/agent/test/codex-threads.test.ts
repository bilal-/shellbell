import {
  appendFileSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { herdrPaneReference } from "../src/backends/herdr/conversation.js";
import { AgentSessions } from "../src/conversation/agent-sessions.js";
import { CodexThreads, codexTitleParts } from "../src/conversation/codex-threads.js";
import { processConversationReference } from "../src/conversation/process-binding.js";

// UUIDv7s: the first twelve hex digits are the start time, 2026-10-30T01:24:34.533Z.
const LOGIN = "01a18a68-9ce5-7df3-9ce8-f7b4c927f5d5";
const OTHER = "01a18a68-9ce5-7aaa-9ce8-f7b4c927f5d6";
const STARTED = 0x01a18a689ce5;
const START = "Sat Oct 24 04:16:59 2026";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function codexHome() {
  const home = realpathSync(mkdtempSync(join(tmpdir(), "shellbell-codex-")));
  dirs.push(home);
  const day = new Date(STARTED);
  const pad = (n: number) => String(n).padStart(2, "0");
  const sessions = join(
    home,
    "sessions",
    String(day.getFullYear()),
    pad(day.getMonth() + 1),
    pad(day.getDate()),
  );
  mkdirSync(sessions, { recursive: true });
  let now = 0;
  return {
    home,
    tick: () => (now += 5000),
    threads: new CodexThreads(home, { now: () => now }),
    /** A session's file, as Codex writes it: its folder in the first record. */
    session(id: string, cwd: string, firstLine?: string) {
      const meta = {
        type: "session_meta",
        payload: { id, cwd, base_instructions: "x".repeat(70_000) },
      };
      writeFileSync(
        join(sessions, `rollout-2026-10-29T21-24-34-${id}.jsonl`),
        `${firstLine ?? JSON.stringify(meta)}\n{"type":"event_msg"}\n`,
      );
    },
    name(id: string, thread_name: string) {
      appendFileSync(
        join(home, "session_index.jsonl"),
        `${JSON.stringify({ id, thread_name, updated_at: "2026-10-30T01:25:28Z" })}\n`,
      );
    },
  };
}

describe("Codex window titles", () => {
  it("reads the session name and project from Codex's default title", () => {
    const parts = { name: "Fix the login", project: "shellbell" };
    expect(codexTitleParts("Fix the login | shellbell")).toEqual(parts);
    // Working, listening, and waiting for the owner each add a mark first.
    expect(codexTitleParts("⠹ Fix the login | shellbell")).toEqual(parts);
    expect(codexTitleParts("● ⠹ Fix the login | shellbell")).toEqual(parts);
    expect(codexTitleParts("[ ! ] Action Required | Fix the login | shellbell")).toEqual(parts);
    expect(codexTitleParts("[ . ] Action Required | Fix the login | shellbell")).toEqual(parts);
    // A name may itself hold the separator; the project never does.
    expect(codexTitleParts("A | B | shellbell")).toEqual({ name: "A | B", project: "shellbell" });
  });

  it("finds no name in a title without one", () => {
    // A session not named yet shows only its project.
    expect(codexTitleParts("shellbell")).toBeNull();
    expect(codexTitleParts("⠹ shellbell")).toBeNull();
    expect(codexTitleParts("●")).toBeNull();
    expect(codexTitleParts(" | shellbell")).toBeNull();
  });
});

describe("binding a Codex window to the session its title names", () => {
  it("finds the one named session in that project and folder", () => {
    const f = codexHome();
    f.session(LOGIN, "/work/shellbell");
    f.name(LOGIN, "Fix the login");
    expect(f.threads.find("⠹ Fix the login | shellbell", "/work/shellbell")).toBe(LOGIN);
    expect(f.threads.find("Fix the login | shellbell")).toBe(LOGIN);
  });

  it("matches Codex's shortened name and project", () => {
    const f = codexHome();
    const long = "Make the phone show which computer is asleep and why it stopped";
    const project = "a-project-name-longer-than-the-limit";
    f.session(LOGIN, `/work/${project}`);
    f.name(LOGIN, long);
    expect(
      f.threads.find(`${long.slice(0, 45)}... | ${project.slice(0, 21)}...`, `/work/${project}`),
    ).toBe(LOGIN);
  });

  it("names a Git checkout's folder as the project of a folder inside it", () => {
    const f = codexHome();
    const repo = join(f.home, "repo");
    mkdirSync(join(repo, ".git"), { recursive: true });
    f.session(LOGIN, join(repo, "apps", "agent"));
    f.name(LOGIN, "Fix the login");
    expect(f.threads.find("Fix the login | repo")).toBe(LOGIN);
    expect(f.threads.find("Fix the login | agent")).toBe(LOGIN);
    expect(f.threads.find("Fix the login | apps")).toBeNull();
  });

  it("refuses a session in another folder or project", () => {
    const f = codexHome();
    f.session(LOGIN, "/work/shellbell");
    f.name(LOGIN, "Fix the login");
    expect(f.threads.find("Fix the login | shellbell", "/work/other/shellbell")).toBeNull();
    expect(f.threads.find("Fix the login | sous")).toBeNull();
  });

  it("refuses two sessions with one name in one project", () => {
    const f = codexHome();
    f.session(LOGIN, "/work/shellbell");
    f.session(OTHER, "/work/shellbell");
    f.name(LOGIN, "Run night shift");
    f.name(OTHER, "Run night shift");
    expect(f.threads.find("Run night shift | shellbell", "/work/shellbell")).toBeNull();
  });

  it("tells same-named sessions in different projects apart", () => {
    const f = codexHome();
    f.session(LOGIN, "/work/shellbell");
    f.session(OTHER, "/work/sous");
    f.name(LOGIN, "Run night shift");
    f.name(OTHER, "Run night shift");
    expect(f.threads.find("Run night shift | sous", "/work/sous")).toBe(OTHER);
  });

  it("follows a rename and refuses the old name", () => {
    const f = codexHome();
    f.session(LOGIN, "/work/shellbell");
    f.name(LOGIN, "Fix the login");
    expect(f.threads.find("Fix the login | shellbell")).toBe(LOGIN);
    f.name(LOGIN, "Fix sign-in");
    f.tick();
    expect(f.threads.find("Fix the login | shellbell")).toBeNull();
    expect(f.threads.find("Fix sign-in | shellbell")).toBe(LOGIN);
  });

  it("refuses a name whose session file is missing or isn't that session", () => {
    const f = codexHome();
    f.name(LOGIN, "Fix the login");
    expect(f.threads.find("Fix the login | shellbell")).toBeNull();
    f.session(
      LOGIN,
      "/work/shellbell",
      JSON.stringify({ type: "session_meta", payload: { id: OTHER, cwd: "/work/shellbell" } }),
    );
    f.tick();
    expect(f.threads.find("Fix the login | shellbell")).toBeNull();
  });

  it("finds a session whose file appears after its name", () => {
    const f = codexHome();
    f.name(LOGIN, "Fix the login");
    expect(f.threads.find("Fix the login | shellbell")).toBeNull();
    f.session(LOGIN, "/work/shellbell");
    // A missing file is looked for again after a while, not on every title change.
    expect(f.threads.find("Fix the login | shellbell")).toBeNull();
    f.tick();
    f.tick();
    expect(f.threads.find("Fix the login | shellbell")).toBe(LOGIN);
  });

  it("ignores a line Codex is still writing", () => {
    const f = codexHome();
    f.session(LOGIN, "/work/shellbell");
    f.name(LOGIN, "Fix the login");
    appendFileSync(join(f.home, "session_index.jsonl"), `{"id":"${OTHER}","thread_na`);
    expect(f.threads.find("Fix the login | shellbell")).toBe(LOGIN);
  });

  it("binds a Herdr pane running Codex without a hook record", () => {
    const f = codexHome();
    f.session(LOGIN, "/work/shellbell");
    f.name(LOGIN, "Fix the login");
    const records = new AgentSessions(join(f.home, "no-records"));
    const pane = {
      agent: "codex",
      pane_id: "w1:p1",
      terminal_title: "Fix the login | shellbell",
      foreground_cwd: "/work/shellbell",
    };
    expect(herdrPaneReference(pane, records, f.threads)).toEqual({
      agent: "codex",
      kind: "id",
      value: LOGIN,
    });
    // Only Codex names its session in its title.
    expect(herdrPaneReference({ ...pane, agent: "gemini" }, records, f.threads)).toBeNull();
    expect(
      herdrPaneReference({ ...pane, foreground_cwd: "/work/other" }, records, f.threads),
    ).toBeNull();
  });

  it("binds a tmux or iTerm2 pane whose foreground Codex has no hook record", async () => {
    const f = codexHome();
    f.session(LOGIN, "/work/shellbell");
    f.name(LOGIN, "Fix the login");
    let asked = 0;
    const bind = (ps: string) =>
      processConversationReference("/dev/ttys003", new AbortController().signal, {
        run: async () => ps,
        codexPane: { iterm: "session" },
        codexSessions: new AgentSessions(join(f.home, "no-records")),
        codexThreads: f.threads,
        codexTitle: async () => {
          asked++;
          return { title: "Fix the login | shellbell", cwd: "/work/shellbell" };
        },
      });
    expect(await bind(` 4100 S+   ${START}     codex\n`)).toEqual({
      agent: "codex",
      kind: "id",
      value: LOGIN,
      owner: `process:/dev/ttys003:4100:${START}:${LOGIN}`,
    });
    // A Codex in the background, or no Codex at all, never has its title read.
    asked = 0;
    expect(await bind(` 4100 S    ${START}     codex\n 4000 S+   ${START}     zsh\n`)).toBeNull();
    expect(asked).toBe(0);
  });
});
