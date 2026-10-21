import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ConversationReference } from "../src/conversation/reference.js";
import { createTranscriptIdentityProbe } from "../src/conversation/transcript-binding.js";
import { TranscriptFile } from "../src/conversation/transcript-file.js";
import { TranscriptLocator } from "../src/conversation/transcript-locator.js";

const id = "11111111-1111-4111-8111-111111111111";
const other = "22222222-2222-4222-8222-222222222222";
const initial: ConversationReference = {
  agent: "claude",
  kind: "id",
  value: id,
  owner: "pane:owner-1",
};
const temporary: string[] = [];
afterEach(async () => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  await Promise.all(temporary.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

async function fixture(agent: "claude" | "codex" = "claude") {
  const dir = await realpath(await mkdtemp(join(tmpdir(), "shellbell-binding-")));
  temporary.push(dir);
  const root = join(dir, agent === "claude" ? "projects" : "sessions");
  const project = join(root, agent === "claude" ? "project" : "2026/10/21");
  await mkdir(project, { recursive: true });
  const path = join(
    project,
    agent === "claude" ? `${id}.jsonl` : `rollout-2026-10-21T10-00-00-${id}.jsonl`,
  );
  await writeFile(path, '{"type":"test","text":"synthetic fixture"}\n');
  let enabled = true;
  let current: ConversationReference | null = { ...initial, agent };
  const options = {
    enabled: () => enabled,
    roots: { claude: agent === "claude" ? [root] : [], codex: agent === "codex" ? [root] : [] },
  };
  const locator = new TranscriptLocator(options);
  const reference = vi.fn(async (_signal: AbortSignal) => current);
  const probe = createTranscriptIdentityProbe({ enabled: options.enabled, reference, locator });
  return {
    root,
    project,
    path,
    options,
    locator,
    reference,
    probe,
    get current() {
      return current;
    },
    set current(value: ConversationReference | null) {
      current = value;
    },
    set enabled(value: boolean) {
      enabled = value;
    },
    open: (signal?: AbortSignal) => TranscriptFile.open({ ...options, identity: probe, signal }),
  };
}

describe("fresh native transcript binding", () => {
  it("connects a proven candidate to descriptor reads without reading its format", async () => {
    const f = await fixture();
    const proof = await f.probe(new AbortController().signal);
    expect(proof).toEqual({ agent: "claude", path: f.path, session: id, owner: initial.owner });
    expect(Object.isFrozen(proof)).toBe(true);
    expect(f.reference).toHaveBeenCalledTimes(2);
    const result = await f.open();
    expect(result.status).toBe("open");
    if (result.status !== "open") return;
    try {
      const read = await result.file.read(0);
      expect(read.status).toBe("data");
      if (read.status === "data")
        expect(Buffer.from(read.bytes).toString()).toContain("synthetic fixture");
    } finally {
      result.file.close();
    }
  });

  it("does no native or filesystem lookup while disabled or pre-aborted", async () => {
    const f = await fixture();
    const locate = vi.spyOn(f.locator, "locate");
    f.enabled = false;
    expect(await f.probe(new AbortController().signal)).toBeNull();
    f.enabled = true;
    expect(await f.probe(AbortSignal.abort())).toBeNull();
    expect(f.reference).not.toHaveBeenCalled();
    expect(locate).not.toHaveBeenCalled();
  });

  it.each<ConversationReference | null>([
    null,
    { ...initial, value: other },
    { ...initial, owner: "pane:owner-2" },
    { ...initial, agent: "codex" },
    { ...initial, kind: "path", value: "/test/transcript.jsonl" },
  ])("rejects a native identity change during lookup", async (next) => {
    const f = await fixture();
    const original = f.locator.locate.bind(f.locator);
    vi.spyOn(f.locator, "locate").mockImplementation(async (...args) => {
      const result = await original(...args);
      f.current = next;
      return result;
    });
    expect(await f.open()).toEqual({ status: "stopped", reason: "unbound" });
  });

  it("captures native evidence instead of following a mutable adapter object", async () => {
    const f = await fixture();
    const original = f.locator.locate.bind(f.locator);
    vi.spyOn(f.locator, "locate").mockImplementation(async (...args) => {
      const result = await original(...args);
      Object.assign(f.current!, { owner: "pane:changed" });
      return result;
    });
    expect(await f.probe(new AbortController().signal)).toBeNull();
  });

  it("captures only candidate fields and cannot be redirected by later port mutation", async () => {
    const f = await fixture();
    const candidate = {
      agent: "claude" as const,
      path: f.path,
      session: id,
      extra: "private internal detail",
    };
    vi.spyOn(f.locator, "locate").mockResolvedValue({ status: "candidate", candidate });
    let calls = 0;
    f.reference.mockImplementation(async () => {
      if (++calls === 2) candidate.path = "/test/wrong.jsonl";
      return f.current;
    });
    expect(await f.probe(new AbortController().signal)).toEqual({
      agent: "claude",
      path: f.path,
      session: id,
      owner: initial.owner,
    });
  });

  it("withholds the filesystem lookup when consent changes after the first native proof", async () => {
    const f = await fixture();
    const locate = vi.spyOn(f.locator, "locate");
    f.reference.mockImplementationOnce(async () => {
      f.enabled = false;
      return f.current;
    });
    expect(await f.probe(new AbortController().signal)).toBeNull();
    expect(locate).not.toHaveBeenCalled();
  });

  it("leaves unknown native identity and busy lookup unbound without retrying inside the proof", async () => {
    const f = await fixture();
    const locate = vi.spyOn(f.locator, "locate").mockResolvedValue({ status: "busy" });
    f.current = null;
    expect(await f.probe(new AbortController().signal)).toBeNull();
    expect(locate).not.toHaveBeenCalled();
    f.current = initial;
    f.reference.mockClear();
    expect(await f.probe(new AbortController().signal)).toBeNull();
    expect(f.reference).toHaveBeenCalledTimes(1);
    expect(locate).toHaveBeenCalledTimes(1);
  });

  it("re-resolves every proof so a newly ambiguous ID cannot keep yielding bytes", async () => {
    const f = await fixture();
    const result = await f.open();
    expect(result.status).toBe("open");
    if (result.status !== "open") return;
    const duplicate = join(f.root, "other-project");
    await mkdir(duplicate);
    await writeFile(join(duplicate, `${id}.jsonl`), "other private conversation");
    try {
      expect(await result.file.read(0)).toEqual({ status: "stopped", reason: "unbound" });
    } finally {
      result.file.close();
    }
  });

  it("accepts a canonical explicit native path", async () => {
    const f = await fixture();
    f.current = { ...initial, kind: "path", value: f.path };
    expect(await f.probe(new AbortController().signal)).toEqual({
      agent: "claude",
      path: f.path,
      session: id,
      owner: initial.owner,
    });
  });

  it("binds a dated Codex rollout and stops when another rollout for its thread appears", async () => {
    const f = await fixture("codex");
    const result = await f.open();
    expect(result.status).toBe("open");
    if (result.status !== "open") return;
    try {
      expect(await result.file.read(0)).toMatchObject({ status: "data" });
      await writeFile(
        join(f.project, `rollout-2026-10-21T11-00-00-${id}_${other}.jsonl`),
        "different rollout",
      );
      expect(await result.file.read(0)).toEqual({ status: "stopped", reason: "unbound" });
    } finally {
      result.file.close();
    }
  });

  it("ends the current reader generation on busy lookup rather than silently using its old path", async () => {
    const f = await fixture();
    const result = await f.open();
    expect(result.status).toBe("open");
    if (result.status !== "open") return;
    try {
      vi.spyOn(f.locator, "locate").mockResolvedValueOnce({ status: "busy" });
      expect(await result.file.read(0)).toEqual({ status: "stopped", reason: "unbound" });
      expect(await result.file.read(0)).toEqual({ status: "stopped", reason: "unbound" });
    } finally {
      result.file.close();
    }
  });

  it("ends an open file's generation when native ownership changes", async () => {
    const f = await fixture();
    const result = await f.open();
    expect(result.status).toBe("open");
    if (result.status !== "open") return;
    f.current = { ...initial, owner: "pane:owner-2" };
    try {
      expect(await result.file.read(0)).toEqual({ status: "stopped", reason: "changed" });
      f.current = initial;
      expect(await result.file.read(0)).toEqual({ status: "stopped", reason: "changed" });
    } finally {
      result.file.close();
    }
  });

  it("passes the reader's proof cancellation to a waiting native observation", async () => {
    const f = await fixture();
    const locate = vi.spyOn(f.locator, "locate");
    f.reference.mockImplementation(
      (signal) =>
        new Promise((_resolve, reject) => {
          signal.addEventListener("abort", () => reject(new Error("cancelled")), { once: true });
        }),
    );
    vi.useFakeTimers();
    const pending = f.open();
    await vi.advanceTimersByTimeAsync(2001);
    expect(await pending).toEqual({ status: "stopped", reason: "unbound" });
    expect(f.reference.mock.calls[0]?.[0].aborted).toBe(true);
    expect(locate).not.toHaveBeenCalled();
  });

  it("passes the reader's proof cancellation to a waiting lookup", async () => {
    const f = await fixture();
    const locate = vi.spyOn(f.locator, "locate").mockImplementation(
      (_ref, signal) =>
        new Promise((resolve) => {
          signal?.addEventListener(
            "abort",
            () => resolve({ status: "unavailable", reason: "cancelled" }),
            { once: true },
          );
        }),
    );
    vi.useFakeTimers();
    const pending = f.open();
    await vi.advanceTimersByTimeAsync(2001);
    expect(await pending).toEqual({ status: "stopped", reason: "unbound" });
    expect(locate.mock.calls[0]?.[1]?.aborted).toBe(true);
    expect(f.reference).toHaveBeenCalledTimes(1);
  });

  it.each(["cancel", "disable"] as const)(
    "stops on %s after the last native observation",
    async (action) => {
      const f = await fixture();
      const controller = new AbortController();
      let calls = 0;
      f.reference.mockImplementation(async () => {
        if (++calls === 2) {
          if (action === "cancel") controller.abort();
          else f.enabled = false;
        }
        return f.current;
      });
      expect(await f.probe(controller.signal)).toBeNull();
    },
  );

  it("never turns a native failure into a private error message", async () => {
    const f = await fixture();
    f.reference.mockRejectedValue(new Error("private native details"));
    expect(await f.probe(new AbortController().signal)).toBeNull();
  });

  it.each(["session", "agent", "path"] as const)(
    "refuses a mismatched candidate %s before the second native probe",
    async (field) => {
      const f = await fixture();
      if (field === "path") f.current = { ...initial, kind: "path", value: f.path };
      vi.spyOn(f.locator, "locate").mockResolvedValue({
        status: "candidate",
        candidate: {
          agent: field === "agent" ? "codex" : "claude",
          session: field === "session" ? other : id,
          path: field === "path" ? "/test/other.jsonl" : f.path,
        },
      });
      expect(await f.probe(new AbortController().signal)).toBeNull();
      expect(f.reference).toHaveBeenCalledTimes(1);
    },
  );
});
