import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { resolveClaudeBackground } from "../src/conversation/claude-background.js";

const ORIGINAL = "751d88e5-1e9c-437f-92d4-27fa084a5c0c";
const CURRENT = "ac41fdcd-1d9a-4a5c-9a5f-4d8aad79650d";
const START = "Sat Oct 24 04:16:59 2026";
const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function setup() {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "shellbell-claude-bg-")));
  dirs.push(dir);
  mkdirSync(join(dir, "sessions"));
  const parent = {
    pid: 4100,
    procStart: START,
    sessionId: ORIGINAL,
    kind: "interactive",
    parkedJobId: "job-one",
  };
  const background = {
    pid: 5100,
    procStart: START,
    sessionId: CURRENT,
    kind: "bg",
    jobId: "job-one",
  };
  const save = (record: { pid: number; [key: string]: unknown }) =>
    writeFileSync(join(dir, "sessions", `${record.pid}.json`), JSON.stringify(record));
  save(parent);
  save(background);
  let processes = `4100 ${START}\n5100 ${START}\n`;
  let duringProof = () => {};
  const signal = new AbortController();
  const resolve = () =>
    resolveClaudeBackground(
      { agent: "claude", kind: "id", value: ORIGINAL },
      async () => [4100],
      signal.signal,
      {
        dir,
        run: async () => {
          duringProof();
          return processes;
        },
      },
    );
  return {
    dir,
    parent,
    background,
    save,
    resolve,
    signal,
    setProcesses: (value: string) => {
      processes = value;
    },
    duringProof: (fn: () => void) => {
      duringProof = fn;
    },
  };
}

describe("Claude conversations moved into a background agent", () => {
  it("resolves the explicit job relationship under both live process lifetimes", async () => {
    const f = setup();
    expect(await f.resolve()).toEqual({
      status: "resolved",
      session: CURRENT,
      owner: `claude-background:4100:${START}:5100:${START}:job-one`,
    });
  });

  it("keeps a normal interactive conversation on its native identity", async () => {
    const f = setup();
    f.save({ ...f.parent, parkedJobId: undefined });
    expect(await f.resolve()).toEqual({ status: "unchanged" });
  });

  it("refuses a missing job, PID reuse and multiple live owners", async () => {
    const f = setup();
    f.save({ ...f.background, jobId: "another-job" });
    expect(await f.resolve()).toEqual({ status: "unavailable" });
    f.save(f.background);
    f.setProcesses(`4100 ${START}\n5100 Fri Oct 23 01:00:00 2026\n`);
    expect(await f.resolve()).toEqual({ status: "unavailable" });
    f.save({ ...f.background, pid: 5200 });
    f.setProcesses(`4100 ${START}\n5100 ${START}\n5200 ${START}\n`);
    expect(await f.resolve()).toEqual({ status: "unavailable" });
  });

  it("ignores a stale registry file when exactly one matching owner is live", async () => {
    const f = setup();
    f.save({ ...f.background, pid: 5200 });
    expect(await f.resolve()).toMatchObject({ status: "resolved", session: CURRENT });
  });

  it("refuses a switch or cancellation during the process proof", async () => {
    const f = setup();
    f.duringProof(() => f.save({ ...f.parent, parkedJobId: "another-job" }));
    expect(await f.resolve()).toEqual({ status: "unavailable" });
    f.save(f.parent);
    f.duringProof(() => f.signal.abort());
    expect(await f.resolve()).toEqual({ status: "unavailable" });
  });

  it("rejects symlinked records and an unreadable foreground registry file", async () => {
    const f = setup();
    rmSync(join(f.dir, "sessions", "5100.json"));
    writeFileSync(join(f.dir, "copied.json"), JSON.stringify(f.background));
    symlinkSync(join(f.dir, "copied.json"), join(f.dir, "sessions", "5100.json"));
    expect(await f.resolve()).toEqual({ status: "unavailable" });
    writeFileSync(join(f.dir, "sessions", "4100.json"), "{");
    expect(await f.resolve()).toEqual({ status: "unavailable" });
  });
});
