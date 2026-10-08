import { act, createElement } from "react";
import { createRoot } from "test-renderer";
import { expect, it, vi } from "vitest";
import { Toast } from "../src/ui/Toast";

vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
vi.mock("react-native", () => ({ View: "View", Text: "Text" }));

it("gives replacement messages a full reading interval and cancels timers on unmount", async () => {
  vi.useFakeTimers();
  const root = createRoot();
  const onDone = vi.fn();
  try {
    await act(async () => root.render(createElement(Toast, { text: "First message", onDone })));
    await act(async () => vi.advanceTimersByTime(2900));
    await act(async () => root.render(createElement(Toast, { text: "New message", onDone })));
    await act(async () => vi.advanceTimersByTime(2999));
    expect(onDone).not.toHaveBeenCalled();
    await act(async () => vi.advanceTimersByTime(1));
    expect(onDone).toHaveBeenCalledTimes(1);
    await act(async () => root.render(createElement(Toast, { text: "Last message", onDone })));
    await act(async () => root.unmount());
    await act(async () => vi.advanceTimersByTime(3000));
    expect(onDone).toHaveBeenCalledTimes(1);
  } finally {
    await act(async () => root.unmount());
    vi.useRealTimers();
  }
});
