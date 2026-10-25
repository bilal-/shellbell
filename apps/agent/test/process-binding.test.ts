import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { processConversationReference } from "../src/conversation/process-binding.js";

const CLAUDE_ID = "751d88e5-1e9c-437f-92d4-27fa084a5c0c";
const AGY_ID = "ac41fdcd-1d9a-4a5c-9a5f-4d8aad79650d";
const START = "Sat Oct 24 04:16:59 2026";
const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function setup(
  ps: string,
  files: (presence: string) => Record<number, readonly string[]> = () => ({}),
) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "shellbell-bind-")));
  dirs.push(root);
  const claudeDir = join(root, "claude");
  const antigravityDir = join(root, "agy");
  mkdirSync(join(claudeDir, "sessions"), { recursive: true });
  const calls: string[][] = [];
  const run = async (file: string, args: readonly string[]) => {
    calls.push([file, ...args]);
    if (file === "ps") return ps;
    const pid = Number(args[args.indexOf("-p") + 1]);
    return (files(join(antigravityDir, "presence"))[pid] ?? [])
      .map((path) => `p${pid}\nn${path}`)
      .join("\n");
  };
  const bind = (tty = "/dev/ttys003") =>
    processConversationReference(tty, new AbortController().signal, {
      run,
      claudeDir,
      antigravityDir,
      platform: "darwin",
    });
  const session = (pid: number, value: Record<string, unknown>) =>
    writeFileSync(join(claudeDir, "sessions", `${pid}.json`), JSON.stringify(value));
  return { bind, session, calls, presence: join(antigravityDir, "presence") };
}

describe("binding a terminal to its agent's conversation by process", () => {
  it("proves Claude Code by its session file's pid and start time", async () => {
    const f = setup(
      ` 4000 Ss   ${START}     -zsh\n 4100 S+   ${START}     /usr/local/bin/claude\n`,
    );
    f.session(4100, { pid: 4100, sessionId: CLAUDE_ID, procStart: START });
    expect(await f.bind()).toEqual({
      agent: "claude",
      kind: "id",
      value: CLAUDE_ID,
      owner: `process:/dev/ttys003:4100:${START}`,
    });
    // `ps` runs with the terminal name only, never a path from elsewhere.
    expect(f.calls[0]).toEqual(["ps", "-t", "ttys003", "-o", "pid=,stat=,lstart=,comm="]);
  });

  it("proves Claude Code by its session file whatever its process is called", async () => {
    // Claude Code can show as `node` or its own version number, depending on how it started.
    for (const command of ["node", "2.1.310", "claude-code"]) {
      const f = setup(` 4100 S+   ${START}     ${command}\n`);
      f.session(4100, { pid: 4100, sessionId: CLAUDE_ID, procStart: START });
      expect(await f.bind()).toMatchObject({ agent: "claude", value: CLAUDE_ID });
    }
  });

  it("asks lsof for numeric addresses so it never waits on name lookups", async () => {
    const f = setup(` 5000 S+   ${START}     antigravity\n`, (presence) => ({
      5000: [join(presence, `${AGY_ID}.lock`)],
    }));
    expect(await f.bind()).toMatchObject({ agent: "agy", value: AGY_ID });
    const lsof = f.calls.find(([file]) => file === "lsof")!;
    expect(lsof).toEqual(expect.arrayContaining(["-n", "-P"]));
  });

  it("proves the conversation a process holds now, not one it held before", async () => {
    let held = AGY_ID;
    const f = setup(` 5000 S+   ${START}     agy\n`, (presence) => ({
      5000: [join(presence, `${held}.lock`)],
    }));
    expect(await f.bind()).toMatchObject({ value: AGY_ID });
    held = CLAUDE_ID;
    expect(await f.bind()).toMatchObject({ value: CLAUDE_ID });
  });

  it("ignores a session file left by an earlier process with the same pid", async () => {
    const f = setup(` 4100 S+   ${START}     claude\n`);
    f.session(4100, { pid: 4100, sessionId: CLAUDE_ID, procStart: "Fri Oct 23 01:00:00 2026" });
    expect(await f.bind()).toBeNull();
  });

  it("ignores agents in the background of the terminal", async () => {
    const f = setup(` 4100 S    ${START}     claude\n`);
    f.session(4100, { pid: 4100, sessionId: CLAUDE_ID, procStart: START });
    expect(await f.bind()).toBeNull();
  });

  it("proves Antigravity by the one presence lock it holds open", async () => {
    const ps = ` 5000 S+   ${START}     agy\n`;
    const holds = (paths: (presence: string) => string[]) =>
      setup(ps, (presence) => ({ 5000: paths(presence) })).bind();
    expect(await holds((presence) => ["/dev/ttys003", join(presence, `${AGY_ID}.lock`)])).toEqual({
      agent: "agy",
      kind: "id",
      value: AGY_ID,
      owner: `process:/dev/ttys003:5000:${START}`,
    });
    expect(await holds(() => [])).toBeNull();
    // Only that tool's own presence folder counts, and only one conversation at a time.
    expect(await holds(() => [`/tmp/presence/${AGY_ID}.lock`])).toBeNull();
    expect(
      await holds((presence) => [
        join(presence, `${AGY_ID}.lock`),
        join(presence, `${CLAUDE_ID}.lock`),
      ]),
    ).toBeNull();
    expect(await holds((presence) => [join(presence, "not-an-id.lock")])).toBeNull();
  });

  it("refuses two different conversations in one terminal's foreground", async () => {
    const f = setup(` 4100 S+   ${START}     claude\n 4200 S+   ${START}     claude\n`);
    f.session(4100, { pid: 4100, sessionId: CLAUDE_ID, procStart: START });
    f.session(4200, { pid: 4200, sessionId: AGY_ID, procStart: START });
    expect(await f.bind()).toBeNull();
  });

  it("refuses anything that isn't a terminal device", async () => {
    const f = setup(` 4100 S+   ${START}     claude\n`);
    f.session(4100, { pid: 4100, sessionId: CLAUDE_ID, procStart: START });
    for (const tty of ["", "ttys003", "/dev/../etc/passwd", "/dev/ttys003; rm", "/tmp/ttys003"])
      expect(await f.bind(tty)).toBeNull();
    expect(f.calls).toEqual([]);
  });
});
