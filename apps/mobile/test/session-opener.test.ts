import { afterEach, describe, expect, it, vi } from "vitest";
import { createSessionOpener } from "../src/notifications/session-opener";

afterEach(() => vi.useRealTimers());

function opener(current = () => false) {
  const navigate = vi.fn();
  const push = vi.fn();
  const value = createSessionOpener({
    pairedFps: () => ["f1"],
    navigate,
    push,
    isSessionCurrent: () => current(),
    sessionId: (route) => `tmux:${route}`,
  });
  return { value, navigate, push };
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
