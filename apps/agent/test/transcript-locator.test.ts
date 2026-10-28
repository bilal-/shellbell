import { mkdirSync, renameSync, writeFileSync } from "node:fs";
import * as fs from "node:fs/promises";
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AgentTranscriptReference } from "../src/conversation/reference.js";
import {
  TRANSCRIPT_LOCATOR_DIRECTORIES,
  TRANSCRIPT_LOCATOR_ENTRIES,
  TRANSCRIPT_LOCATOR_MS,
  TranscriptLocator,
} from "../src/conversation/transcript-locator.js";

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return { ...actual, lstat: vi.fn(actual.lstat), opendir: vi.fn(actual.opendir) };
});

const session = "11111111-1111-4111-8111-111111111111";
const other = "22222222-2222-4222-8222-222222222222";
const reference: AgentTranscriptReference = { agent: "claude", kind: "id", value: session };
const temporary: string[] = [];
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
afterEach(async () => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.mocked(fs.lstat).mockReset();
  vi.mocked(fs.opendir).mockReset();
  await Promise.all(temporary.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

async function fixture() {
  const dir = await realpath(await mkdtemp(join(tmpdir(), "shellbell-locator-")));
  temporary.push(dir);
  const projects = join(dir, "projects");
  const sessions = join(dir, "sessions");
  await Promise.all([mkdir(projects), mkdir(sessions)]);
  let enabled = true;
  const options = { enabled: () => enabled, roots: { claude: [projects], codex: [sessions] } };
  const locator = new TranscriptLocator(options);
  const put = async (path: string) => {
    await mkdir(dirname(path), { recursive: true });
    // Deliberately not JSON: locator must not interpret or claim to verify file contents.
    await writeFile(path, "not a parsed transcript\n");
    return path;
  };
  return {
    dir,
    projects,
    sessions,
    options,
    locator,
    put,
    set enabled(value: boolean) {
      enabled = value;
    },
    claude: (id = session, project = "-code-project") =>
      put(join(projects, project, `${id}.jsonl`)),
    codex: (id = session, tail = "", stamp = "2026-10-21T10-00-00", day = "2026/10/21") =>
      put(join(sessions, day, `rollout-${stamp}-${id}${tail}.jsonl`)),
  };
}

describe("bounded transcript candidate lookup", () => {
  it("finds the explicitly named Claude session, regardless of newer unrelated files", async () => {
    const f = await fixture();
    const path = await f.claude();
    await f.claude(other, "-other-project");
    expect(await f.locator.locate(reference)).toEqual({
      status: "candidate",
      candidate: { agent: "claude", path, session },
    });
  });

  it("finds dated Codex rollouts and supports a distinct rollout ID", async () => {
    const f = await fixture();
    const path = await f.codex(session, `_${other}`);
    await f.codex(other);
    expect(await f.locator.locate({ ...reference, agent: "codex" })).toEqual({
      status: "candidate",
      candidate: { agent: "codex", path, session },
    });
  });

  it("supports a legacy Codex rollout directly in the sessions root", async () => {
    const f = await fixture();
    const path = await f.codex(session, "", "2025-01-01T00-00-00", "");
    expect(await f.locator.locate({ ...reference, agent: "codex" })).toMatchObject({
      status: "candidate",
      candidate: { path },
    });
  });

  it.each(["claude", "codex"] as const)("refuses duplicate %s matches", async (agent) => {
    const f = await fixture();
    if (agent === "claude") {
      await f.claude();
      await f.claude(session, "-other-project");
    } else {
      await f.codex();
      await f.codex(session, `_${other}`);
    }
    expect(await f.locator.locate({ ...reference, agent })).toEqual({
      status: "unavailable",
      reason: "ambiguous",
    });
  });

  it.each([".jsonl.zst", ".zst", ".json.zst", " 2.jsonl", "-copy.jsonl", ".JSONL"])(
    "fails closed on the unknown Codex variant %s",
    async (suffix) => {
      const f = await fixture();
      await f.codex();
      await f.put(join(f.sessions, `rollout-2026-10-21T11-00-00-${session}${suffix}`));
      expect(await f.locator.locate({ ...reference, agent: "codex" })).toEqual({
        status: "unavailable",
        reason: "unbound",
      });
    },
  );

  it("an explicit native path disambiguates duplicate filenames", async () => {
    const f = await fixture();
    const path = await f.codex();
    await f.codex(session, `_${other}`);
    const result = await f.locator.locate({ agent: "codex", kind: "path", value: path });
    expect(result).toMatchObject({ status: "candidate", candidate: { path, session } });
    if (result.status === "candidate") expect(Object.isFrozen(result.candidate)).toBe(true);
  });

  it("rejects subagent files and arbitrary nested directories", async () => {
    const f = await fixture();
    const path = await f.put(join(f.projects, "project", "subagents", `${session}.jsonl`));
    await f.put(join(f.sessions, "arbitrary", `rollout-2026-10-21T10-00-00-${session}.jsonl`));
    expect(await f.locator.locate(reference)).toEqual({ status: "unavailable", reason: "unbound" });
    expect(await f.locator.locate({ ...reference, agent: "codex" })).toEqual({
      status: "unavailable",
      reason: "unbound",
    });
    expect(await f.locator.locate({ ...reference, kind: "path", value: path })).toEqual({
      status: "unavailable",
      reason: "unsafe",
    });
  });

  it("ignores missing optional roots but still checks all present roots", async () => {
    const f = await fixture();
    const path = await f.claude();
    f.options.roots.claude.push(join(f.dir, "absent"), f.projects);
    expect(await f.locator.locate(reference)).toMatchObject({
      status: "candidate",
      candidate: { path },
    });
    const otherRoot = join(f.dir, "other-projects");
    await f.put(join(otherRoot, "project", `${session}.jsonl`));
    f.options.roots.claude.push(otherRoot);
    expect(await f.locator.locate(reference)).toEqual({
      status: "unavailable",
      reason: "ambiguous",
    });
  });

  it("does no lookup before consent or after pre-cancellation", async () => {
    const f = await fixture();
    Object.defineProperty(f.options, "roots", {
      get: () => {
        throw new Error("roots accessed");
      },
    });
    f.enabled = false;
    expect(await f.locator.locate(reference)).toEqual({
      status: "unavailable",
      reason: "disabled",
    });
    f.enabled = true;
    expect(await f.locator.locate(reference, AbortSignal.abort())).toEqual({
      status: "unavailable",
      reason: "cancelled",
    });
  });

  it("admits only one lookup at a time and releases the permit", async () => {
    const f = await fixture();
    await f.claude();
    const first = f.locator.locate(reference);
    expect(await f.locator.locate(reference)).toEqual({ status: "busy" });
    expect(await first).toMatchObject({ status: "candidate" });
    expect(await f.locator.locate(reference)).toMatchObject({ status: "candidate" });
  });

  it.each(["disabled", "cancelled"] as const)(
    "stops an in-flight lookup when %s",
    async (reason) => {
      const f = await fixture();
      await f.claude();
      const controller = new AbortController();
      const pending = f.locator.locate(reference, controller.signal);
      if (reason === "disabled") f.enabled = false;
      else controller.abort();
      expect(await pending).toEqual({ status: "unavailable", reason });
      f.enabled = true;
      await vi.waitFor(async () =>
        expect(await f.locator.locate(reference)).toMatchObject({ status: "candidate" }),
      );
    },
  );

  it("does not follow a candidate symlink, including an explicit path", async () => {
    const f = await fixture();
    const outside = await f.put(join(f.dir, "private.jsonl"));
    const path = join(f.projects, "project", `${session}.jsonl`);
    await mkdir(dirname(path));
    await symlink(outside, path);
    for (const ref of [reference, { ...reference, kind: "path" as const, value: path }])
      expect(await f.locator.locate(ref)).toEqual({ status: "unavailable", reason: "unsafe" });
  });

  it.each(["cancelled", "limit"] as const)(
    "returns %s from a stuck operation while keeping its permit until cleanup",
    async (reason) => {
      const f = await fixture();
      await f.claude();
      const opened = deferred();
      const release = deferred();
      const closed = deferred();
      const controller = new AbortController();
      const removed = vi.spyOn(controller.signal, "removeEventListener");
      const { opendir: original } = await vi.importActual<typeof fs>("node:fs/promises");
      let held = false;
      vi.mocked(fs.opendir).mockImplementation(async (...args) => {
        const dir = await original(...args);
        if (held) return dir;
        held = true;
        const close = dir.close.bind(dir);
        dir.close = (async () => {
          try {
            await close();
          } finally {
            closed.resolve();
          }
        }) as typeof dir.close;
        opened.resolve();
        await release.promise;
        return dir;
      });
      if (reason === "limit") vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
      const pending = f.locator.locate(reference, controller.signal);
      await opened.promise;
      try {
        if (reason === "cancelled") controller.abort();
        else await vi.advanceTimersByTimeAsync(TRANSCRIPT_LOCATOR_MS);
        expect(await pending).toEqual({ status: "unavailable", reason });
        expect(removed).toHaveBeenCalledTimes(1);
        expect(await f.locator.locate(reference)).toEqual({ status: "busy" });
      } finally {
        release.resolve();
        await closed.promise;
        vi.useRealTimers();
      }
      await vi.waitFor(async () =>
        expect(await f.locator.locate(reference)).toMatchObject({ status: "candidate" }),
      );
    },
  );

  it.each(["cancelled", "disabled"] as const)(
    "cleans every nested directory when %s during a leaf read",
    async (reason) => {
      const f = await fixture();
      const path = await f.codex();
      const blocked = deferred();
      const release = deferred();
      const cleaned = deferred();
      const controller = new AbortController();
      const { opendir: original } = await vi.importActual<typeof fs>("node:fs/promises");
      let closes = 0;
      vi.mocked(fs.opendir).mockImplementation(async (...args) => {
        const dir = await original(...args);
        const close = dir.close.bind(dir);
        dir.close = (async () => {
          await close();
          if (++closes === 4) cleaned.resolve();
        }) as typeof dir.close;
        if (args[0] === dirname(path)) {
          dir.read = (async () => {
            blocked.resolve();
            await release.promise;
            return null;
          }) as typeof dir.read;
        }
        return dir;
      });
      const pending = f.locator.locate({ ...reference, agent: "codex" }, controller.signal);
      await blocked.promise;
      if (reason === "cancelled") controller.abort();
      else f.enabled = false;
      release.resolve();
      expect(await pending).toEqual({ status: "unavailable", reason });
      await cleaned.promise;
      expect(closes).toBe(4);
    },
  );

  it("allows configured root aliases but refuses an aliased explicit file path", async () => {
    const f = await fixture();
    const path = await f.claude();
    const alias = join(f.dir, "alias");
    await symlink(f.projects, alias);
    f.options.roots.claude = [alias];
    expect(await f.locator.locate(reference)).toMatchObject({
      status: "candidate",
      candidate: { path },
    });
    expect(
      await f.locator.locate({
        ...reference,
        kind: "path",
        value: path.replace(f.projects, alias),
      }),
    ).toEqual({ status: "unavailable", reason: "unsafe" });
  });

  it("refuses overlapping roots instead of changing the supported directory layout", async () => {
    const f = await fixture();
    const path = await f.claude();
    f.options.roots.claude.push(dirname(path));
    expect(await f.locator.locate(reference)).toEqual({ status: "unavailable", reason: "unsafe" });
    f.options.roots.claude.pop();
    expect(await f.locator.locate(reference)).toMatchObject({ status: "candidate" });
  });

  it("rejects a formerly absent root that appears during lookup", async () => {
    const f = await fixture();
    const path = await f.claude();
    const absent = join(f.dir, "absent-projects");
    f.options.roots.claude.push(absent);
    const { lstat: original } = await vi.importActual<typeof fs>("node:fs/promises");
    vi.mocked(fs.lstat).mockImplementation((async (...args: Parameters<typeof fs.lstat>) => {
      const stat = await original(...args);
      if (args[0] === path) mkdirSync(absent, { recursive: true });
      return stat;
    }) as typeof fs.lstat);
    expect(await f.locator.locate(reference)).toEqual({ status: "unavailable", reason: "changed" });
  });

  it("rejects aliases that could hide a second project match", async () => {
    const f = await fixture();
    const path = await f.claude();
    await symlink(dirname(path), join(f.projects, "alias"));
    expect(await f.locator.locate(reference)).toEqual({ status: "unavailable", reason: "unsafe" });
  });

  it("rejects a symlink in the Codex date hierarchy", async () => {
    const f = await fixture();
    const outside = join(f.dir, "elsewhere");
    await f.put(join(outside, "10", "21", `rollout-2026-10-21T10-00-00-${session}.jsonl`));
    await symlink(outside, join(f.sessions, "2026"));
    expect(await f.locator.locate({ ...reference, agent: "codex" })).toEqual({
      status: "unavailable",
      reason: "unsafe",
    });
  });

  it("refuses a directory named like the matching file", async () => {
    const f = await fixture();
    await mkdir(join(f.projects, "project", `${session}.jsonl`), { recursive: true });
    expect(await f.locator.locate(reference)).toEqual({ status: "unavailable", reason: "unsafe" });
  });

  it.each(["../private", "session-one", "", "x".repeat(4097)])(
    "rejects unsupported IDs before filesystem lookup",
    async (value) => {
      const f = await fixture();
      Object.defineProperty(f.options, "roots", {
        get: () => {
          throw new Error("roots accessed");
        },
      });
      expect(await f.locator.locate({ ...reference, value })).toEqual({
        status: "unavailable",
        reason: "unbound",
      });
    },
  );

  it("refuses paths outside the supplied roots", async () => {
    const f = await fixture();
    const path = await f.put(join(f.dir, "elsewhere", `${session}.jsonl`));
    expect(await f.locator.locate({ ...reference, kind: "path", value: path })).toEqual({
      status: "unavailable",
      reason: "unsafe",
    });
  });

  it("refuses outside paths before querying them and reports missing in-root files as unbound", async () => {
    const f = await fixture();
    const outside = join(f.dir, "private", `${session}.jsonl`);
    expect(await f.locator.locate({ ...reference, kind: "path", value: outside })).toEqual({
      status: "unavailable",
      reason: "unsafe",
    });
    expect(vi.mocked(fs.lstat).mock.calls.some(([path]) => path === outside)).toBe(false);
    expect(
      await f.locator.locate({
        ...reference,
        kind: "path",
        value: join(f.projects, "project", `${session}.jsonl`),
      }),
    ).toEqual({ status: "unavailable", reason: "unbound" });
  });

  it("refuses a dangling root alias without calling it a transient change", async () => {
    const f = await fixture();
    await f.claude();
    const alias = join(f.dir, "dangling");
    await symlink(join(f.dir, "absent"), alias);
    f.options.roots.claude.push(alias);
    expect(await f.locator.locate(reference)).toEqual({ status: "unavailable", reason: "unsafe" });
  });

  it("refuses a regular file as a root and an ownership mismatch", async () => {
    const f = await fixture();
    const path = await f.claude();
    f.options.roots.claude.push(path);
    expect(await f.locator.locate(reference)).toEqual({ status: "unavailable", reason: "unsafe" });
    f.options.roots.claude.pop();
    if (process.getuid) {
      vi.spyOn(process, "getuid").mockReturnValue(process.getuid() + 1);
      expect(await f.locator.locate(reference)).toEqual({
        status: "unavailable",
        reason: "unsafe",
      });
    }
  });

  it("normalizes an uppercase UUID without loosening filename selection", async () => {
    const f = await fixture();
    const id = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    const path = await f.claude(id);
    expect(await f.locator.locate({ ...reference, value: id.toUpperCase() })).toMatchObject({
      status: "candidate",
      candidate: { path, session: id },
    });
  });

  it("contains close failures without returning a candidate or retaining its permit", async () => {
    const f = await fixture();
    await f.claude();
    const { opendir: original } = await vi.importActual<typeof fs>("node:fs/promises");
    vi.mocked(fs.opendir).mockImplementationOnce(async (...args) => {
      const dir = await original(...args);
      const close = dir.close.bind(dir);
      dir.close = (async () => {
        await close();
        throw new Error("private path must not escape");
      }) as typeof dir.close;
      return dir;
    });
    expect(await f.locator.locate(reference)).toEqual({
      status: "unavailable",
      reason: "unreadable",
    });
    expect(await f.locator.locate(reference)).toMatchObject({ status: "candidate" });
  });

  it("bounds total directory work even when a matching file exists", async () => {
    const f = await fixture();
    const path = await f.claude();
    const overflowRoot = join(f.dir, "overflow-projects");
    await mkdir(overflowRoot);
    f.options.roots.claude.push(overflowRoot);
    await Promise.all(
      Array.from({ length: TRANSCRIPT_LOCATOR_DIRECTORIES }, (_, i) =>
        mkdir(join(overflowRoot, `p-${i}`)),
      ),
    );
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    vi.spyOn(performance, "now").mockReturnValue(0);
    expect(await f.locator.locate(reference)).toEqual({ status: "unavailable", reason: "limit" });
    expect(vi.mocked(fs.lstat).mock.calls.some(([name]) => name === path)).toBe(true);
    f.options.roots.claude.pop();
    expect(await f.locator.locate(reference)).toMatchObject({ status: "candidate" });
  });

  it("bounds enumerated entries independently of its directory and time limits", async () => {
    const f = await fixture();
    const path = await f.codex();
    const overflowRoot = join(f.dir, "overflow-sessions");
    await mkdir(overflowRoot);
    f.options.roots.codex.push(overflowRoot);
    const { opendir: original } = await vi.importActual<typeof fs>("node:fs/promises");
    let enumerated = 0;
    vi.mocked(fs.opendir).mockImplementation(async (...args) => {
      const dir = await original(...args);
      if (args[0] === overflowRoot) {
        // Exercise the actual scan budget without creating 16,385 unrelated disk files.
        dir.read = (async () =>
          enumerated <= TRANSCRIPT_LOCATOR_ENTRIES
            ? { name: `ignored-${enumerated++}` }
            : null) as typeof dir.read;
      }
      return dir;
    });
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    vi.spyOn(performance, "now").mockReturnValue(0);
    expect(await f.locator.locate({ ...reference, agent: "codex" })).toEqual({
      status: "unavailable",
      reason: "limit",
    });
    expect(vi.mocked(fs.lstat).mock.calls.some(([name]) => name === path)).toBe(true);
    expect(enumerated).toBeGreaterThan(TRANSCRIPT_LOCATOR_ENTRIES - 10);
    expect(enumerated).toBeLessThanOrEqual(TRANSCRIPT_LOCATOR_ENTRIES + 1);
  });

  it("closes an opened directory when cancellation arrives during opening", async () => {
    const f = await fixture();
    await f.claude();
    const controller = new AbortController();
    const { opendir: original } = await vi.importActual<typeof fs>("node:fs/promises");
    const close = vi.fn();
    vi.mocked(fs.opendir).mockImplementation(async (...args) => {
      const dir = await original(...args);
      const originalClose = dir.close.bind(dir);
      dir.close = (() => {
        close();
        return originalClose();
      }) as typeof dir.close;
      controller.abort();
      return dir;
    });
    expect(await f.locator.locate(reference, controller.signal)).toEqual({
      status: "unavailable",
      reason: "cancelled",
    });
    expect(close).toHaveBeenCalledTimes(1);
  });

  it("does not use a partial match when another configured root cannot be read", async () => {
    const f = await fixture();
    const path = await f.claude();
    const inaccessible = join(f.dir, "inaccessible");
    await mkdir(inaccessible);
    f.options.roots.claude.push(inaccessible);
    const { opendir: original } = await vi.importActual<typeof fs>("node:fs/promises");
    vi.mocked(fs.opendir).mockImplementation(async (...args) => {
      if (args[0] === inaccessible)
        throw Object.assign(new Error("private path must not escape"), { code: "EACCES" });
      return original(...args);
    });
    expect(await f.locator.locate(reference)).toEqual({
      status: "unavailable",
      reason: "unreadable",
    });
    expect(vi.mocked(fs.lstat).mock.calls.some(([name]) => name === path)).toBe(true);
  });

  it("checks consent again before handing off a successful lookup", async () => {
    const f = await fixture();
    await f.claude();
    let checks = 0;
    f.options.enabled = () => {
      checks++;
      return true;
    };
    expect(await f.locator.locate(reference)).toMatchObject({ status: "candidate" });
    const finalScanCheck = checks - 1;
    checks = 0;
    let enabled = true;
    f.options.enabled = () => {
      if (++checks === finalScanCheck)
        queueMicrotask(() => {
          enabled = false;
        });
      return enabled;
    };
    expect(await f.locator.locate(reference)).toEqual({
      status: "unavailable",
      reason: "disabled",
    });
  });

  it.each(
    [[], ["relative"], Array.from({ length: 9 }, () => "/unused")].map((roots) => ({ roots })),
  )("rejects invalid root configuration", async ({ roots }) => {
    const f = await fixture();
    f.options.roots.claude = roots;
    expect(await f.locator.locate(reference)).toEqual({
      status: "unavailable",
      reason: "unsafe",
    });
  });

  it("expires its cooperative scan deadline without returning a partial match", async () => {
    const f = await fixture();
    const path = await f.claude();
    let clock = 0;
    vi.spyOn(performance, "now").mockImplementation(() => clock);
    const { lstat: original } = await vi.importActual<typeof fs>("node:fs/promises");
    let observations = 0;
    vi.mocked(fs.lstat).mockImplementation((async (...args: Parameters<typeof fs.lstat>) => {
      const stat = await original(...args);
      if (args[0] === path && ++observations === 2) clock = TRANSCRIPT_LOCATOR_MS;
      return stat;
    }) as typeof fs.lstat);
    expect(await f.locator.locate(reference)).toEqual({ status: "unavailable", reason: "limit" });
    expect(observations).toBe(2);
  });

  it("rejects a namespace change observed during the scan", async () => {
    const f = await fixture();
    const path = await f.claude();
    const { lstat: original } = await vi.importActual<typeof fs>("node:fs/promises");
    let changed = false;
    vi.mocked(fs.lstat).mockImplementation((async (...args: Parameters<typeof fs.lstat>) => {
      const stat = await original(...args);
      if (args[0] === f.projects && !changed) {
        changed = true;
        mkdirSync(join(f.projects, "new-project"));
      }
      return stat;
    }) as typeof fs.lstat);
    expect(await f.locator.locate(reference)).toEqual({ status: "unavailable", reason: "changed" });
    expect(await f.locator.locate({ ...reference, kind: "path", value: path })).toMatchObject({
      status: "candidate",
    });
  });

  it.each(["new-file", "replacement-directory"] as const)(
    "rejects %s after a project was searched",
    async (kind) => {
      const f = await fixture();
      const path = await f.claude();
      const { lstat: original } = await vi.importActual<typeof fs>("node:fs/promises");
      let changed = false;
      vi.mocked(fs.lstat).mockImplementation((async (...args: Parameters<typeof fs.lstat>) => {
        const stat = await original(...args);
        if (args[0] === path && !changed) {
          changed = true;
          if (kind === "new-file") writeFileSync(join(dirname(path), `${other}.jsonl`), "new");
          else {
            renameSync(dirname(path), `${dirname(path)}-old`);
            mkdirSync(dirname(path));
            writeFileSync(path, "replacement");
          }
        }
        return stat;
      }) as typeof fs.lstat);
      expect(await f.locator.locate(reference)).toEqual({
        status: "unavailable",
        reason: "changed",
      });
      expect(changed).toBe(true);
    },
  );

  it("rechecks the file inode after namespace verification", async () => {
    const f = await fixture();
    const path = await f.claude();
    const { lstat: original } = await vi.importActual<typeof fs>("node:fs/promises");
    let observations = 0;
    vi.mocked(fs.lstat).mockImplementation((async (...args: Parameters<typeof fs.lstat>) => {
      if (args[0] === path && ++observations === 2) {
        renameSync(path, `${path}.old`);
        writeFileSync(path, "replacement");
      }
      return original(...args);
    }) as typeof fs.lstat);
    const result = await f.locator.locate(reference);
    expect(observations).toBe(2);
    expect(result).toEqual({ status: "unavailable", reason: "changed" });
  });
});

describe("Gemini", () => {
  async function gemini() {
    const dir = await realpath(await mkdtemp(join(tmpdir(), "shellbell-locator-")));
    temporary.push(dir);
    const tmp = join(dir, "tmp");
    await mkdir(tmp);
    const locator = new TranscriptLocator({
      enabled: () => true,
      roots: { claude: [join(dir, "none")], codex: [join(dir, "none")], gemini: [tmp] },
    });
    const put = async (path: string) => {
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, "not json");
      return path;
    };
    const find = () => locator.locate({ agent: "gemini", kind: "id", value: session });
    return { tmp, put, find };
  }

  it("finds a session's file by the start of its ID, in any project's chats", async () => {
    const f = await gemini();
    const path = await f.put(
      join(f.tmp, "proj", "chats", "session-2026-01-01T00-00-11111111.jsonl"),
    );
    await f.put(join(f.tmp, "proj", "chats", "session-2026-01-01T00-00-22222222.jsonl"));
    await f.put(join(f.tmp, "proj", "logs.json"));
    expect(await f.find()).toEqual({
      status: "candidate",
      candidate: { agent: "gemini", path, session },
    });
  });

  it("fails closed when the shortened ID matches two files", async () => {
    const f = await gemini();
    await f.put(join(f.tmp, "a", "chats", "session-2026-01-01T00-00-11111111.jsonl"));
    await f.put(join(f.tmp, "b", "chats", "session-2026-01-02T00-00-11111111.jsonl"));
    expect(await f.find()).toEqual({ status: "unavailable", reason: "ambiguous" });
  });

  it("refuses symlinked project folders and paths named by the agent", async () => {
    const f = await gemini();
    const real = await f.put(
      join(f.tmp, "..", "elsewhere", "chats", "session-2026-01-01T00-00-11111111.jsonl"),
    );
    await symlink(dirname(dirname(real)), join(f.tmp, "linked"));
    expect(await f.find()).toEqual({ status: "unavailable", reason: "unsafe" });
    const locator = new TranscriptLocator({
      enabled: () => true,
      roots: { claude: [f.tmp], codex: [f.tmp], gemini: [f.tmp] },
    });
    expect(await locator.locate({ agent: "gemini", kind: "path", value: real })).toEqual({
      status: "unavailable",
      reason: "unsafe",
    });
  });
});
