import { describe, expect, it } from "vitest";
import { buildRingNotification } from "../src/notifications/content";
import { resolveTarget } from "../src/notifications/routing";
import { sidToRoute } from "../src/util/routes";

const known = () => ({ title: "claude-code", backend: "herdr" as const });
const none = () => undefined;

describe("buildRingNotification", () => {
  it("names the session and keys the notification to it", () => {
    const n = buildRingNotification({ computerFp: "abc", sessionId: "s1", kind: "blocked" }, known);
    expect(n.identifier).toBe("abc:s1");
    expect(n.title).toBe("claude-code");
    expect(n.body).toBe("An agent is waiting for you");
  });

  it.each([
    ["prompt", "A command finished"],
    ["idle", "A session went quiet — waiting for you?"],
    ["blocked", "An agent is waiting for you"],
  ])("uses the relay's wording for %s", (kind, body) => {
    const n = buildRingNotification({ computerFp: "abc", sessionId: "s1", kind }, known);
    expect(n.body).toBe(body);
  });

  it("falls back to the backend label when the title is unknown", () => {
    const n = buildRingNotification({ computerFp: "abc", sessionId: "s9", kind: "idle" }, () => ({
      title: "",
      backend: "tmux" as const,
    }));
    expect(n.title).toBe("tmux");
  });

  it("falls back to Session when nothing is known", () => {
    const n = buildRingNotification({ computerFp: "abc", sessionId: "s9", kind: "idle" }, none);
    expect(n.title).toBe("Session");
  });

  it("never renders a raw session id when a title is known", () => {
    const n = buildRingNotification({ computerFp: "abc", sessionId: "s9", kind: "idle" }, known);
    expect(n.title).not.toContain("s9");
    expect(n.body).not.toContain("s9");
  });

  it("never renders a raw session id when the backend is known but the title is empty", () => {
    const n = buildRingNotification({ computerFp: "abc", sessionId: "s9", kind: "idle" }, () => ({
      title: "",
      backend: "tmux" as const,
    }));
    expect(n.title).not.toContain("s9");
    expect(n.body).not.toContain("s9");
  });

  it("carries the payload as `data` so a tap can still route (spec §6, review C1)", () => {
    const payload = { computerFp: "abc", sessionId: "s1", kind: "blocked" };
    const n = buildRingNotification(payload, known);
    expect(n.data).toEqual(payload);
  });

  it("that `data` is exactly what resolveTarget needs to route the tap (review C1)", () => {
    const fp = "a".repeat(26);
    const payload = { computerFp: fp, sessionId: "iterm2:w0t0p0", kind: "blocked" };
    const n = buildRingNotification(payload, known);
    expect(resolveTarget(n.data, [fp])).toEqual({
      computerFp: fp,
      sessionRoute: sidToRoute("iterm2:w0t0p0"),
    });
  });
});
