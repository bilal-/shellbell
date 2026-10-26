import { execFileSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { herdrPaneReference } from "../src/backends/herdr/conversation.js";
import {
  codexHookScript,
  codexIntegrationStatus,
  installCodexIntegration,
  uninstallCodexIntegration,
} from "../src/codex-integration.js";
import { CodexSessions, codexSessionsDir } from "../src/conversation/codex-sessions.js";
import { processConversationReference } from "../src/conversation/process-binding.js";

const SESSION = "01a17402-7349-7091-a9ca-019dc9c34733";
const OTHER = "01a175cc-9142-7fc0-9da4-1c820cffbe82";
const START = "Sat Oct 24 04:16:59 2026";
const STARTED = Date.parse(`${START} UTC`) / 1000;
const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
function temp() {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "shellbell-codex-")));
  dirs.push(dir);
  return dir;
}

/** Runs the real hook script with a pane's environment and Codex's hook input. */
function runHook(records: string, env: Record<string, string>, input: object) {
  const script = join(records, "..", "hook.sh");
  writeFileSync(script, codexHookScript(records));
  return execFileSync("sh", [script], {
    input: JSON.stringify(input),
    env: { PATH: "/usr/bin:/bin", ...env },
    encoding: "utf8",
  });
}

describe("the Codex session hook", () => {
  it("records the pane it ran in, prints nothing, and is found by that pane", () => {
    const records = join(temp(), "codex-sessions");
    const output = runHook(
      records,
      { TMUX: "/private/tmp/tmux-501/default,123,0", TMUX_PANE: "%7" },
      { session_id: SESSION, transcript_path: "/x/rollout.jsonl", hook_event_name: "SessionStart" },
    );
    // A SessionStart hook's output would become context for the model.
    expect(output).toBe("");
    expect(readdirSync(records)).toEqual([expect.stringMatching(/^\d+-\d+\.rec$/)]);
    const sessions = new CodexSessions(records);
    const tmux = { socket: "/private/tmp/tmux-501/default", pane: "%7" };
    expect(sessions.find({ tmux })).toMatchObject({ session: SESSION });
    expect(sessions.find({ tmux: { ...tmux, pane: "%8" } })).toBeNull();
    expect(sessions.find({ tmux: { ...tmux, socket: "/private/tmp/tmux-501/other" } })).toBeNull();
    // A pane can't be named by a marker it didn't record.
    expect(sessions.find({ herdr: "w1:p1" })).toBeNull();
  });

  it("keeps hostile environment values out of the record's other lines", () => {
    const records = join(temp(), "codex-sessions");
    runHook(
      records,
      { ITERM_SESSION_ID: "w0t1p0:ABCD-1234\ntmux_pane=%1", HERDR_PANE_ID: "w9:p1;rm -rf" },
      { session_id: SESSION },
    );
    const [name] = readdirSync(records);
    const text = readFileSync(join(records, name!), "utf8");
    expect(
      text
        .split("\n\n")[0]!
        .split("\n")
        .filter((l) => l.startsWith("tmux_pane=")),
    ).toEqual(["tmux_pane="]);
    const sessions = new CodexSessions(records);
    expect(sessions.find({ iterm: "abcd-1234tmux_pane=%1" })).toMatchObject({ session: SESSION });
    expect(sessions.find({ herdr: "w9:p1rm-rf" })).toMatchObject({ session: SESSION });
  });

  it("finds the newest session started in a pane, and only after its Codex started", () => {
    const records = join(temp(), "codex-sessions");
    mkdirSync(records);
    const write = (time: number, session: string, pane = "w9:p1") =>
      writeFileSync(
        join(records, `${time}-1.rec`),
        `shellbell-codex-hook 1\ntime=${time}\nherdr_pane=${pane}\n\n${JSON.stringify({ session_id: session })}`,
      );
    write(STARTED - 600, OTHER);
    write(STARTED + 5, SESSION);
    const sessions = new CodexSessions(records);
    expect(sessions.find({ herdr: "w9:p1" })?.session).toBe(SESSION);
    // A Codex started after the newest record hasn't recorded its session yet.
    expect(sessions.find({ herdr: "w9:p1" }, (STARTED + 60) * 1000)).toBeNull();
    // A newer file is read once the directory changes.
    write(STARTED + 70, OTHER);
    expect(sessions.find({ herdr: "w9:p1" }, (STARTED + 60) * 1000)?.session).toBe(OTHER);
  });

  it("ignores other formats and bad IDs, and removes month-old records", () => {
    const records = join(temp(), "codex-sessions");
    mkdirSync(records);
    writeFileSync(join(records, "1-1.rec"), `something else\ntime=1\nherdr_pane=a\n\n{}`);
    writeFileSync(
      join(records, "2-1.rec"),
      `shellbell-codex-hook 1\ntime=2\nherdr_pane=a\n\n${JSON.stringify({ session_id: "../x" })}`,
    );
    const old = join(records, "3-1.rec");
    writeFileSync(
      old,
      `shellbell-codex-hook 1\ntime=3\nherdr_pane=a\n\n${JSON.stringify({ session_id: SESSION })}`,
    );
    utimesSync(old, new Date(0), new Date(0));
    expect(new CodexSessions(records).find({ herdr: "a" })).toBeNull();
    expect(readdirSync(records).sort()).toEqual(["1-1.rec", "2-1.rec"]);
  });
});

describe("installing the Codex integration", () => {
  function setup(hooks?: object, config?: string) {
    const root = temp();
    const p = { codexHome: join(root, "codex"), stateDir: join(root, "state") };
    mkdirSync(p.codexHome);
    if (hooks) writeFileSync(join(p.codexHome, "hooks.json"), JSON.stringify(hooks));
    if (config !== undefined) writeFileSync(join(p.codexHome, "config.toml"), config);
    const read = () => JSON.parse(readFileSync(join(p.codexHome, "hooks.json"), "utf8"));
    return { p, read, config: () => readFileSync(join(p.codexHome, "config.toml"), "utf8") };
  }
  const herdr = { hooks: [{ type: "command", command: "bash herdr.sh session", timeout: 10 }] };

  it("adds its hook beside others, once, and removes only its own", () => {
    const f = setup(
      { hooks: { SessionStart: [herdr], Stop: [herdr] } },
      "[features]\nhooks = true\n",
    );
    expect(installCodexIntegration(f.p)).toEqual({ installed: true, hooksFeature: "on" });
    installCodexIntegration(f.p);
    const added = f.read().hooks.SessionStart;
    expect(added).toHaveLength(2);
    expect(added[0]).toEqual(herdr);
    expect(added[1].hooks[0].command).toContain("codex-session-hook.sh");
    expect(f.config()).toBe("[features]\nhooks = true\n");
    expect(uninstallCodexIntegration(f.p).installed).toBe(false);
    expect(f.read()).toEqual({ hooks: { SessionStart: [herdr], Stop: [herdr] } });
  });

  it("turns Codex hooks on only when they aren't set, never against an explicit false", () => {
    const unset = setup(undefined, 'model = "gpt"\n[features]\nother = true\n');
    installCodexIntegration(unset.p);
    expect(unset.config()).toBe('model = "gpt"\n[features]\nhooks = true\nother = true\n');
    const missing = setup(undefined, 'model = "gpt"');
    installCodexIntegration(missing.p);
    expect(missing.config()).toBe('model = "gpt"\n\n[features]\nhooks = true\n');
    const off = setup(undefined, "[features]\nhooks = false\n");
    expect(() => installCodexIntegration(off.p)).toThrow(/turned off/);
    expect(codexIntegrationStatus(off.p).installed).toBe(false);
  });

  it("installs a hook that records into the state directory the service reads", () => {
    const f = setup(undefined, "[features]\nhooks = true\n");
    installCodexIntegration(f.p);
    const command = f.read().hooks.SessionStart[0].hooks[0].command as string;
    const script = /^sh '(.*)'$/.exec(command)![1]!;
    execFileSync("sh", [script], {
      input: JSON.stringify({ session_id: SESSION }),
      env: { PATH: "/usr/bin:/bin", HERDR_PANE_ID: "w2:p1" },
    });
    expect(
      new CodexSessions(codexSessionsDir(f.p.stateDir)).find({ herdr: "w2:p1" }),
    ).toMatchObject({ session: SESSION });
  });
});

describe("binding Codex panes", () => {
  function records(lines: string) {
    const dir = join(temp(), "codex-sessions");
    mkdirSync(dir);
    writeFileSync(join(dir, `${STARTED + 2}-1.rec`), lines);
    return new CodexSessions(dir);
  }
  const record = (header: string) =>
    `shellbell-codex-hook 1\ntime=${STARTED + 2}\n${header}\n\n${JSON.stringify({ session_id: SESSION })}`;

  it("proves a tmux pane's foreground Codex by the hook's record from after it started", async () => {
    const sessions = records(record("tmux=/tmp/tmux-501/default,1,0\ntmux_pane=%3"));
    const bind = (start: string) =>
      processConversationReference("/dev/ttys003", new AbortController().signal, {
        run: async () => ` 4100 S+   ${start}     codex\n`,
        codexPane: { tmux: { socket: "/tmp/tmux-501/default", pane: "%3" } },
        codexSessions: sessions,
        platform: "darwin",
      });
    expect(await bind(START)).toMatchObject({ agent: "codex", kind: "id", value: SESSION });
    // A Codex started later in the same pane hasn't recorded its own session yet.
    expect(await bind("Sat Oct 24 05:16:59 2026")).toBeNull();
  });

  it("falls back to the hook's record for a Herdr Codex pane Herdr didn't report", () => {
    const sessions = records(record("herdr_pane=wB:p1"));
    expect(herdrPaneReference({ agent: "codex", pane_id: "wB:p1" }, sessions)).toEqual({
      agent: "codex",
      kind: "id",
      value: SESSION,
    });
    // Herdr's own report wins, and other agents never use Codex records.
    const reported = { agent: "codex", kind: "id", source: "herdr:codex", value: OTHER };
    expect(
      herdrPaneReference({ agent: "codex", pane_id: "wB:p1", agent_session: reported }, sessions),
    ).toMatchObject({ value: OTHER });
    expect(herdrPaneReference({ agent: "claude", pane_id: "wB:p1" }, sessions)).toBeNull();
  });
});
