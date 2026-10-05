import type { NotificationPayload } from "@shellbell/protocol";
import { describe, expect, it } from "vitest";
import fixture from "../../../packages/protocol/test/notification-vectors.json";
import { formatNotification } from "../src/notifications/format";

const payload = fixture.payload as NotificationPayload;
describe("meaningful private notification labels", () => {
  it("identifies repo/branch, reason, computer and the specific session", () => {
    expect(
      formatNotification({
        ...payload,
        context: { ...payload.context, agentName: "Claude", shell: "zsh" },
      }),
    ).toEqual({
      title: "shellbell · fix/通知",
      body: "Claude is waiting for your response",
      subtitle: "MacBook · Terminal 2 · zsh",
    });
  });
  it("keeps two same-repo sessions independently recognizable", () => {
    const second = { ...payload, context: { ...payload.context, sessionLabel: "Terminal 3" } };
    expect(formatNotification(second).subtitle).not.toBe(formatNotification(payload).subtitle);
  });
  it("prefers an explicit custom name and falls back without showing opaque IDs", () => {
    expect(
      formatNotification({ ...payload, context: { ...payload.context, customName: "Release" } })
        .title,
    ).toBe("Release");
    expect(
      formatNotification({
        ...payload,
        context: { computerName: "Mac", sessionLabel: "tmux · Pane 2", observedAt: 1 },
      }).title,
    ).toBe("tmux · Pane 2");
  });
  it.each([
    ["quiet", "Session went quiet"],
    ["prompt-returned", "Terminal returned to a prompt"],
    ["agent-finished", "Agent finished"],
    ["command-finished", "Command finished"],
  ] as const)("uses evidence-backed wording for %s", (reason, body) => {
    expect(formatNotification({ ...payload, reason }).body).toBe(body);
  });
  it("reports a failing exit without asserting test results", () => {
    expect(formatNotification({ ...payload, reason: "command-finished", exitCode: 2 }).body).toBe(
      "Command exited with code 2",
    );
  });
});
