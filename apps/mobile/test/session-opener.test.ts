import { afterEach, describe, expect, it, vi } from "vitest";
import { createSessionOpener } from "../src/notifications/session-opener";

afterEach(() => vi.useRealTimers());

function opener(current = () => false, instance = (): string | undefined => undefined) {
  const navigate = vi.fn();
  const push = vi.fn();
  const terminalReplaced = vi.fn();
  const value = createSessionOpener({
    pairedFps: () => ["f1"],
    navigate,
    push,
    isSessionCurrent: () => current(),
    sessionInstance: () => instance(),
    terminalReplaced,
    sessionId: (route) => `tmux:${route}`,
  });
  return { value, navigate, push, terminalReplaced };
}

describe("opening a notification's session", () => {
  it("opens the session once the computer reports it", () => {
    vi.useFakeTimers();
    let ready = false;
    const { value, navigate, push } = opener(() => ready);
    value.open({ computerFp: "f1", sessionRoute: "a" });
    expect(navigate).toHaveBeenCalledWith("/c/f1");
    value.routeChanged("/c/f1");
    ready = true;
    vi.advanceTimersByTime(500);
    expect(push).toHaveBeenCalledExactlyOnceWith("/c/f1/s/a");
  });

  it("stays on the session list when a restarted tmux gave the pane's ID to another", () => {
    const { value, navigate, push, terminalReplaced } = opener(
      () => true,
      () => "tmux-server-912",
    );
    value.open({ computerFp: "f1", sessionRoute: "a", instance: "tmux-server-700" });
    expect(navigate).toHaveBeenCalledWith("/c/f1");
    expect(push).not.toHaveBeenCalled();
    expect(terminalReplaced).toHaveBeenCalledExactlyOnceWith("f1");
  });

  it("opens the pane when its server still runs, or when either side doesn't say", () => {
    for (const [tapped, now] of [
      ["tmux-server-700", "tmux-server-700"],
      [undefined, "tmux-server-912"],
      ["tmux-server-700", undefined],
    ] as const) {
      const { value, push, terminalReplaced } = opener(
        () => true,
        () => now,
      );
      value.open({ computerFp: "f1", sessionRoute: "a", ...(tapped && { instance: tapped }) });
      expect(push).toHaveBeenCalledExactlyOnceWith("/c/f1/s/a");
      expect(terminalReplaced).not.toHaveBeenCalled();
    }
  });

  it("does not pull the user back after they leave the computer screen", () => {
    vi.useFakeTimers();
    let ready = false;
    const { value, push } = opener(() => ready);
    value.open({ computerFp: "f1", sessionRoute: "a" });
    value.routeChanged("/c/f1");
    value.routeChanged("/c/f2");
    ready = true;
    vi.advanceTimersByTime(10_000);
    expect(push).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("waits for the computer screen before treating another route as leaving", () => {
    vi.useFakeTimers();
    let ready = false;
    const { value, push } = opener(() => ready);
    value.routeChanged("/settings");
    value.open({ computerFp: "f1", sessionRoute: "a" });
    // A late report of the screen the tap left behind is not the user leaving.
    value.routeChanged("/settings");
    value.routeChanged("/c/f1");
    ready = true;
    vi.advanceTimersByTime(500);
    expect(push).toHaveBeenCalledExactlyOnceWith("/c/f1/s/a");
  });

  it("retires the open when the user leaves a computer screen they were already on", () => {
    vi.useFakeTimers();
    let ready = false;
    const { value, push } = opener(() => ready);
    value.routeChanged("/c/f1");
    value.open({ computerFp: "f1", sessionRoute: "a" });
    value.routeChanged("/");
    ready = true;
    vi.advanceTimersByTime(10_000);
    expect(push).not.toHaveBeenCalled();
  });

  it("stays on the sessions list when the session never arrives", () => {
    vi.useFakeTimers();
    const { value, push } = opener();
    value.open({ computerFp: "f1", sessionRoute: "a" });
    vi.advanceTimersByTime(20_000);
    expect(push).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("ignores computers that are not paired", () => {
    const { value, navigate } = opener();
    value.open({ computerFp: "other", sessionRoute: "a" });
    expect(navigate).not.toHaveBeenCalled();
  });
});
