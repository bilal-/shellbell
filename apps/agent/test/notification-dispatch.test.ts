import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deriveNotificationKey, openNotification, toBase64Url } from "@shellbell/protocol";
import { afterEach, describe, expect, it, vi } from "vitest";
import { paths } from "../src/config.js";
import { NotificationDispatcher } from "../src/notification-dispatch.js";
import { NotificationState } from "../src/notification-state.js";

const roots: string[] = [];
afterEach(() => {
  vi.useRealTimers();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
const computerFp = "a".repeat(26),
  phoneFp = "b".repeat(26),
  generation = "AAAAAAAAAAAAAAAAAAAAAA";
const key = new Uint8Array(32).fill(7);
const ring = () => ({
  sessionId: "tmux:1",
  kind: "blocked" as const,
  reason: "agent-blocked" as const,
});
function fixture(count = 1, longLabels = false, now = () => 1000) {
  const root = mkdtempSync(join(tmpdir(), "shellbell-notify-dispatch-"));
  roots.push(root);
  const state = new NotificationState(paths(root));
  state.enroll(phoneFp, generation);
  let paired = true,
    current = true,
    capable = true;
  let lookup: () => Promise<{ repository: string; branch?: string }> = async () => ({
    repository: longLabels ? "r".repeat(256) : "private-repo",
    branch: longLabels ? "b".repeat(256) : undefined,
  });
  const pairings = Array.from({ length: count }, (_, i) => ({
    phoneFp: String.fromCharCode(98 + i).repeat(26),
    kPair: toBase64Url(key),
  }));
  for (const p of pairings) state.enroll(p.phoneFp, generation);
  const facts = {
    sessionId: "tmux:1",
    revision: "1",
    sessionLabel: "Pane 1",
    locality: "local" as const,
    cwd: "/fixture",
    ...(longLabels
      ? {
          customName: "c".repeat(256),
          title: "t".repeat(256),
          shell: "s".repeat(64),
          agentName: "a".repeat(64),
        }
      : {}),
  };
  let getFacts = async () => (current ? facts : undefined);
  const dispatcher = new NotificationDispatcher({
    state,
    computerFp,
    computerName: () => "Mac",
    now,
    capable: () => capable,
    pairings: () => (paired ? pairings : []),
    facts: () => getFacts(),
    git: async () => lookup(),
  });
  return {
    dispatcher,
    state,
    setFacts: (v: typeof getFacts) => {
      getFacts = v;
    },
    setPaired: (v: boolean) => {
      paired = v;
    },
    setCurrent: (v: boolean) => {
      current = v;
    },
    setCapable: (v: boolean) => {
      capable = v;
    },
    setLookup: (v: typeof lookup) => {
      lookup = v;
    },
  };
}
describe("private ring dispatch", () => {
  it("issues after context discovery without extending the original freshness window", async () => {
    let clock = 1000;
    const f = fixture(1, false, () => clock);
    f.setFacts(async () => {
      // Deterministically widen the interval that was flaky under suite load.
      clock += 25;
      return {
        sessionId: "tmux:1",
        revision: "1",
        sessionLabel: "Pane 1",
        locality: "local",
        cwd: "/fixture",
      };
    });
    const message = await f.dispatcher.prepare(ring());
    expect(message.type).toBe("notify-context");
    if (message.type !== "notify-context") throw new Error("missing context");
    const box = message.boxes[0]!;
    const payload = openNotification(deriveNotificationKey(key, box), box);
    expect(payload.context.observedAt).toBeGreaterThan(1000);
    expect(payload.issuedAt).toBeGreaterThanOrEqual(payload.context.observedAt);
    expect(payload.expiresAt).toBe(121000);
    expect(payload.sequence).toBe("1");
  });
  it("bounds discovery even when an adapter never answers", async () => {
    const f = fixture();
    vi.useFakeTimers();
    f.setFacts(() => new Promise(() => {}));
    let result: unknown;
    void f.dispatcher.prepare(ring()).then((m) => {
      result = m;
    });
    await vi.advanceTimersByTimeAsync(250);
    expect(result).toMatchObject({ type: "notify" });
    expect(f.state.reserve(phoneFp)?.sequence).toBe("1");
  });
  it("trims optional labels and fanout without increasing the control budget", async () => {
    const f = fixture(10, true);
    const message = await f.dispatcher.prepare(ring());
    if (message.type !== "notify-context") throw new Error("missing context");
    expect(Buffer.byteLength(JSON.stringify(message))).toBeLessThanOrEqual(16_384);
    expect(message.boxes.length).toBeGreaterThan(0);
    expect(message.boxes.length).toBeLessThan(10);
    for (const box of message.boxes) {
      const payload = openNotification(deriveNotificationKey(key, box), box);
      expect(Buffer.byteLength(JSON.stringify(payload))).toBeLessThanOrEqual(1536);
      expect(payload.context.branch).toBeUndefined();
    }
  });
  it("seals per recipient after reserving and retries the exact original event", async () => {
    const f = fixture(),
      event = ring();
    const message = await f.dispatcher.prepare(event);
    expect(message.type).toBe("notify-context");
    if (message.type !== "notify-context") throw new Error("missing context");
    const box = message.boxes[0]!;
    const payload = openNotification(deriveNotificationKey(key, box), box);
    expect(payload).toMatchObject({
      phoneFp,
      sessionId: "tmux:1",
      sequence: "1",
      reason: "agent-blocked",
      context: { repository: "private-repo" },
    });
    expect(JSON.stringify(message)).not.toContain("private-repo");
    expect(await f.dispatcher.prepare(event)).toEqual(message);
    expect(f.state.reserve(phoneFp)?.sequence).toBe("2");
  });
  it.each(["unpair", "session"])("drops stale metadata after %s during discovery", async (what) => {
    const f = fixture();
    f.setLookup(async () => {
      if (what === "unpair") f.setPaired(false);
      else f.setCurrent(false);
      return { repository: "old-private-repo" };
    });
    const message = await f.dispatcher.prepare(ring());
    expect(message.type === "notify-context" ? message.boxes : []).toHaveLength(0);
    expect(f.state.reserve(phoneFp)?.sequence).toBe("1");
  });
  it("falls back once for legacy relay or unenrolled phone", async () => {
    const f = fixture();
    f.setCapable(false);
    expect(await f.dispatcher.prepare(ring())).toMatchObject({ type: "notify", kind: "blocked" });
    f.setCapable(true);
    f.state.forget(phoneFp);
    expect(await f.dispatcher.prepare(ring())).toMatchObject({ type: "notify", kind: "blocked" });
  });
  it("does not retry a cached box after its recipient is unpaired", async () => {
    const f = fixture(),
      event = ring();
    expect((await f.dispatcher.prepare(event)).type).toBe("notify-context");
    f.setPaired(false);
    expect((await f.dispatcher.prepare(event)).type).toBe("notify");
  });
});
