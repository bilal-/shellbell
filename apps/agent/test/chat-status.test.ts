import * as fs from "node:fs/promises";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionChatSchema } from "@shellbell/protocol";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ChatStatus, type ChatStatusOptions } from "../src/conversation/chat-status.js";
import type { ConversationReference } from "../src/conversation/reference.js";
import {
  type TranscriptLocateResult,
  TranscriptLocator,
} from "../src/conversation/transcript-locator.js";

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof fs>();
  return { ...actual, open: vi.fn(actual.open), readFile: vi.fn(actual.readFile) };
});

const claudeSession = "11111111-1111-4111-8111-111111111111";
const codexSession = "22222222-2222-4222-8222-222222222222";
const claude = (owner = "pane-1"): ConversationReference => ({
  agent: "claude",
  kind: "id",
  value: claudeSession,
  owner,
});
const codex = (owner = "pane-2"): ConversationReference => ({
  agent: "codex",
  kind: "id",
  value: codexSession,
  owner,
});
const candidate = (reference: ConversationReference): TranscriptLocateResult => ({
  status: "candidate",
  candidate: {
    agent: reference.agent,
    path: `/test/${reference.value}.jsonl`,
    session: reference.value,
  },
});

function fixture(overrides: Partial<ChatStatusOptions> = {}) {
  const state = {
    enabled: true,
    active: true,
    viewed: new Set<string>(),
    references: new Map<string, ConversationReference | null>(),
  };
  let ids = 0;
  const reference = vi.fn(async (sessionId: string) => state.references.get(sessionId) ?? null);
  const locate = vi.fn(async (value: { agent: string; value: string }) =>
    candidate({ ...value, kind: "id", owner: "" } as ConversationReference),
  );
  const changed = vi.fn();
  const status = new ChatStatus({
    enabled: () => state.enabled,
    active: () => state.active,
    viewed: (id) => state.viewed.has(id),
    supported: () => true,
    reference,
    locator: { locate },
    changed,
    newId: () => `chat-${++ids}`,
    ...overrides,
  });
  return { state, status, reference, locate, changed };
}

describe("chat status", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000_000);
  });
  afterEach(() => vi.useRealTimers());

  it.each([
    ["claude", claude()],
    ["codex", codex()],
  ] as const)("goes from finding to found for %s", async (kind, native) => {
    const f = fixture();
    f.state.references.set("herdr:a", native);
    f.status.update([{ id: "herdr:a", agent: { kind } }]);
    expect(f.status.status("herdr:a")).toEqual({ state: "finding", agent: kind });
    await vi.advanceTimersByTimeAsync(0);
    const found = f.status.status("herdr:a");
    expect(found).toEqual({ state: "found", id: "chat-1", agent: kind });
    expect(SessionChatSchema.safeParse(found).success).toBe(true);
    // Two native proofs around one lookup, the same path conversation reads use.
    expect(f.reference).toHaveBeenCalledTimes(2);
    expect(f.locate).toHaveBeenCalledTimes(1);
    expect(f.changed).toHaveBeenCalled();
    f.status.close();
  });

  it("gives a new id when another agent takes over the pane", async () => {
    const f = fixture();
    f.state.references.set("herdr:a", claude());
    f.status.update([{ id: "herdr:a", agent: { kind: "claude" } }]);
    await vi.advanceTimersByTimeAsync(0);
    const first = f.status.status("herdr:a");
    expect(first).toEqual({ state: "found", id: "chat-1", agent: "claude" });
    f.state.references.set("herdr:a", codex());
    f.status.update([{ id: "herdr:a", agent: { kind: "codex" } }]);
    expect(f.status.status("herdr:a")).toEqual({ state: "finding", agent: "codex" });
    await vi.advanceTimersByTimeAsync(0);
    expect(f.status.status("herdr:a")).toEqual({ state: "found", id: "chat-2", agent: "codex" });
    f.status.close();
  });

  it("keeps the id while the same conversation is proved again, and changes it with the owner", async () => {
    const f = fixture();
    f.state.references.set("herdr:a", claude("one"));
    f.status.update([{ id: "herdr:a", agent: { kind: "claude" } }]);
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(f.reference).toHaveBeenCalledTimes(4);
    expect(f.status.status("herdr:a")).toMatchObject({ state: "found", id: "chat-1" });
    // A /resume Herdr reports without an event shows up at the next refresh.
    f.state.references.set("herdr:a", claude("two"));
    await vi.advanceTimersByTimeAsync(10_000);
    expect(f.status.status("herdr:a")).toMatchObject({ state: "found", id: "chat-2" });
    f.status.close();
  });

  it("ends an idle reader's generation when a fresh proof finds another conversation", async () => {
    const replaced = vi.fn();
    const f = fixture({ replaced });
    f.state.references.set("herdr:a", claude("one"));
    f.status.update([{ id: "herdr:a", agent: { kind: "claude" } }]);
    await vi.advanceTimersByTimeAsync(0);
    expect(replaced).not.toHaveBeenCalled();
    // A /resume with no native event: no reader would notice while its file is unchanged.
    f.state.references.set("herdr:a", claude("two"));
    await vi.advanceTimersByTimeAsync(10_000);
    expect(replaced).toHaveBeenCalledExactlyOnceWith("herdr:a");
    f.state.references.set("herdr:a", claude("three"));
    const id = f.status.status("herdr:a")!.id!;
    expect(await f.status.check("herdr:a", id, new AbortController().signal)).toBe(
      "conversation-changed",
    );
    expect(replaced).toHaveBeenCalledTimes(2);
    f.status.close();
  });

  it("keeps agent-exited until another agent starts or the session ends", async () => {
    const f = fixture();
    f.state.references.set("herdr:a", claude());
    f.status.update([{ id: "herdr:a", agent: { kind: "claude" } }]);
    await vi.advanceTimersByTimeAsync(0);
    f.status.update([{ id: "herdr:a" }]);
    const exited = { state: "none", agent: "claude", reason: "agent-exited" };
    expect(f.status.status("herdr:a")).toEqual(exited);
    const calls = f.reference.mock.calls.length;
    await vi.advanceTimersByTimeAsync(30_000);
    f.status.update([{ id: "herdr:a" }]);
    expect(f.status.status("herdr:a")).toEqual(exited);
    expect(f.reference).toHaveBeenCalledTimes(calls);
    f.status.update([{ id: "herdr:a", agent: { kind: "claude" } }]);
    expect(f.status.status("herdr:a")).toEqual({ state: "finding", agent: "claude" });
    await vi.advanceTimersByTimeAsync(0);
    expect(f.status.status("herdr:a")).toEqual({ state: "found", id: "chat-2", agent: "claude" });
    f.status.update([]);
    expect(f.status.status("herdr:a")).toBeUndefined();
    f.status.close();
  });

  it("says nothing and proves nothing while conversations are off", async () => {
    const f = fixture();
    f.state.enabled = false;
    f.state.references.set("herdr:a", claude());
    f.status.update([{ id: "herdr:a", agent: { kind: "claude" } }]);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(f.status.status("herdr:a")).toBeUndefined();
    expect(f.reference).not.toHaveBeenCalled();
    f.state.enabled = true;
    f.status.wake();
    await vi.advanceTimersByTimeAsync(0);
    expect(f.status.status("herdr:a")).toMatchObject({ state: "found" });
    f.state.enabled = false;
    f.status.wake();
    expect(f.status.status("herdr:a")).toBeUndefined();
    f.status.close();
  });

  it("proves nothing while no phone is connected", async () => {
    const f = fixture();
    f.state.active = false;
    f.state.references.set("herdr:a", claude());
    f.status.update([{ id: "herdr:a", agent: { kind: "claude" } }]);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(f.reference).not.toHaveBeenCalled();
    f.state.active = true;
    f.status.wake();
    await vi.advanceTimersByTimeAsync(0);
    expect(f.status.status("herdr:a")).toMatchObject({ state: "found" });
    f.status.close();
  });

  it("names why there is no chat", async () => {
    const f = fixture();
    f.status.update([{ id: "herdr:cursor", agent: { kind: "cursor" } }]);
    expect(f.status.status("herdr:cursor")).toEqual({
      state: "none",
      agent: "cursor",
      reason: "not-supported",
    });
    f.state.references.set("herdr:limit", claude("limit"));
    f.state.references.set("herdr:ambiguous", claude("ambiguous"));
    f.locate.mockImplementation(
      async (): Promise<TranscriptLocateResult> => ({
        status: "unavailable",
        reason: f.locate.mock.calls.length === 1 ? "limit" : "ambiguous",
      }),
    );
    f.status.update([
      { id: "herdr:cursor", agent: { kind: "cursor" } },
      { id: "herdr:limit", agent: { kind: "claude" } },
      { id: "herdr:ambiguous", agent: { kind: "claude" } },
      { id: "herdr:empty", agent: { kind: "claude" } },
    ]);
    await vi.advanceTimersByTimeAsync(10);
    expect(f.status.status("herdr:limit")).toMatchObject({ reason: "lookup-limit" });
    expect(f.status.status("herdr:ambiguous")).toMatchObject({ reason: "ambiguous" });
    // A missing native identity gets one more look before it is reported.
    expect(f.status.status("herdr:empty")).toEqual({ state: "finding", agent: "claude" });
    await vi.advanceTimersByTimeAsync(1000);
    expect(f.status.status("herdr:empty")).toEqual({
      state: "none",
      agent: "claude",
      reason: "no-history",
    });
    expect(f.reference.mock.calls.some(([id]) => id === "herdr:cursor")).toBe(false);
    f.status.close();
  });

  it("looks up one session at a time, viewed sessions first, and waits for a busy locator", async () => {
    const f = fixture();
    for (const id of ["herdr:a", "herdr:b", "herdr:c"]) f.state.references.set(id, claude(id));
    f.state.viewed.add("herdr:c");
    let busy = 1;
    let active = 0;
    let most = 0;
    f.locate.mockImplementation(async (value) => {
      active++;
      most = Math.max(most, active);
      await Promise.resolve();
      active--;
      if (busy-- > 0) return { status: "busy" };
      return candidate({ ...value, kind: "id", owner: "" } as ConversationReference);
    });
    f.status.update(
      ["herdr:a", "herdr:b", "herdr:c"].map((id) => ({ id, agent: { kind: "claude" } })),
    );
    await vi.advanceTimersByTimeAsync(0);
    // The viewed session went first, found the shared locator busy and waits its turn.
    expect(f.reference.mock.calls[0]![0]).toBe("herdr:c");
    expect(f.status.status("herdr:c")).toEqual({ state: "finding", agent: "claude" });
    await vi.advanceTimersByTimeAsync(1000);
    expect(f.status.status("herdr:c")).toMatchObject({ state: "found" });
    expect(f.status.status("herdr:a")).toMatchObject({ state: "found" });
    expect(f.status.status("herdr:b")).toMatchObject({ state: "found" });
    expect(most).toBe(1);
    f.status.close();
  });

  it("lets input through only for the generation on screen, proved freshly", async () => {
    const f = fixture();
    const signal = new AbortController().signal;
    f.state.references.set("herdr:a", claude("one"));
    f.status.update([{ id: "herdr:a", agent: { kind: "claude" } }]);
    await vi.advanceTimersByTimeAsync(0);
    const calls = f.reference.mock.calls.length;
    expect(await f.status.check("herdr:a", "chat-1", signal)).toBe("ok");
    expect(f.reference).toHaveBeenCalledTimes(calls + 1);
    expect(await f.status.check("herdr:a", "chat-9", signal)).toBe("conversation-changed");
    // A silent owner change: the fresh proof differs, which ends the generation.
    f.state.references.set("herdr:a", claude("two"));
    expect(await f.status.check("herdr:a", "chat-1", signal)).toBe("conversation-changed");
    expect(f.status.status("herdr:a")).toEqual({ state: "finding", agent: "claude" });
    await vi.advanceTimersByTimeAsync(0);
    expect(f.status.status("herdr:a")).toMatchObject({ state: "found", id: "chat-2" });
    f.status.close();
  });

  it("refuses input when the generation changes while its proof is out", async () => {
    const f = fixture();
    const signal = new AbortController().signal;
    f.state.references.set("herdr:a", claude());
    f.status.update([{ id: "herdr:a", agent: { kind: "claude" } }]);
    await vi.advanceTimersByTimeAsync(0);
    let release!: () => void;
    f.reference.mockImplementationOnce(async () => {
      await new Promise<void>((resolve) => {
        release = resolve;
      });
      return claude();
    });
    const pending = f.status.check("herdr:a", "chat-1", signal);
    await Promise.resolve();
    f.status.invalidate("herdr:a");
    release();
    expect(await pending).toBe("conversation-changed");
    f.status.close();
  });

  it("rechecks a change event at once", async () => {
    const f = fixture();
    f.state.references.set("herdr:a", claude("one"));
    f.status.update([{ id: "herdr:a", agent: { kind: "claude" } }]);
    await vi.advanceTimersByTimeAsync(0);
    f.state.references.set("herdr:a", claude("two"));
    f.status.invalidate("herdr:a");
    expect(f.status.status("herdr:a")).toEqual({ state: "finding", agent: "claude" });
    await vi.advanceTimersByTimeAsync(0);
    expect(f.status.status("herdr:a")).toEqual({ state: "found", id: "chat-2", agent: "claude" });
    f.status.close();
  });
});

describe("chat status lookups", () => {
  const temporary: string[] = [];
  afterEach(async () => {
    await Promise.all(
      temporary.splice(0).map((path) => rm(path, { recursive: true, force: true })),
    );
  });

  it("finds a chat with the real locator without reading the transcript", async () => {
    const dir = await realpath(await mkdtemp(join(tmpdir(), "shellbell-chat-status-")));
    temporary.push(dir);
    const projects = join(dir, "projects");
    await mkdir(join(projects, "project"), { recursive: true });
    await writeFile(join(projects, "project", `${claudeSession}.jsonl`), "{}\n");
    vi.mocked(fs.open).mockClear();
    vi.mocked(fs.readFile).mockClear();
    const status = new ChatStatus({
      enabled: () => true,
      active: () => true,
      viewed: () => false,
      supported: () => true,
      reference: async () => claude(),
      locator: new TranscriptLocator({
        roots: { claude: [projects], codex: [join(dir, "codex")] },
        enabled: () => true,
      }),
      changed: () => {},
    });
    try {
      status.update([{ id: "herdr:a", agent: { kind: "claude" } }]);
      await vi.waitFor(() => expect(status.status("herdr:a")).toMatchObject({ state: "found" }));
      expect(fs.open).not.toHaveBeenCalled();
      expect(fs.readFile).not.toHaveBeenCalled();
    } finally {
      status.close();
    }
  });
});
