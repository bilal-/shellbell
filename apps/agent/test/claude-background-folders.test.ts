import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { resolveClaudeBackgroundIn } from "../src/conversation/claude-background.js";

const SESSION = "751d88e5-1e9c-437f-92d4-27fa084a5c0c";
const START = "Sat Oct 24 04:16:59 2026";
const roots: string[] = [];
afterEach(() => {
  for (const dir of roots.splice(0)) rmSync(dir, { recursive: true, force: true });
});
function folder(records: Record<number, string>): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "shellbell-claude-")));
  roots.push(dir);
  mkdirSync(join(dir, "sessions"));
  for (const [pid, text] of Object.entries(records))
    writeFileSync(join(dir, "sessions", `${pid}.json`), text);
  return dir;
}
const resolve = (dirs: string[]) =>
  resolveClaudeBackgroundIn(
    dirs,
    { agent: "claude", kind: "id", value: SESSION },
    async () => [4100],
    new AbortController().signal,
    async () => "",
  );

describe("Claude background jobs across config folders", () => {
  it("ignores an unreadable record in a folder that doesn't hold the session", async () => {
    const live = folder({
      4100: JSON.stringify({
        pid: 4100,
        sessionId: SESSION,
        procStart: START,
        kind: "interactive",
      }),
    });
    const stray = folder({ 4100: "{not json" });
    expect(await resolve([stray, live])).toEqual({ status: "unchanged" });
    expect(await resolve([live, stray])).toEqual({ status: "unchanged" });
  });

  it("proves nothing when the only record for the pane can't be read", async () => {
    expect(await resolve([folder({}), folder({ 4100: "{not json" })])).toEqual({
      status: "unavailable",
    });
    expect(await resolve([folder({})])).toEqual({ status: "unchanged" });
  });

  it("proves nothing when two folders name different background jobs", async () => {
    const parked = (job: string) =>
      JSON.stringify({
        pid: 4100,
        sessionId: SESSION,
        procStart: START,
        kind: "interactive",
        parkedJobId: job,
      });
    // Neither job is live here, so each folder alone is unavailable; the pair must be too.
    expect(await resolve([folder({ 4100: parked("a") }), folder({ 4100: parked("b") })])).toEqual({
      status: "unavailable",
    });
  });
});
