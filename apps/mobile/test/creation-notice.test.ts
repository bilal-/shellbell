import { describe, expect, it, vi } from "vitest";

vi.mock("expo-sqlite/kv-store", () => ({
  default: { getItemSync: () => null, setItemSync() {} },
}));

const { announceCreated, creationNotice } = await import("../src/util/creation-notice");
const { useConnectionsStore } = await import("../src/store/connections");

const session = (id: string, windowId: string, extra: object = {}) =>
  ({ id, backend: id.split(":")[0], windowId, ...extra }) as never;

describe("where a new session went", () => {
  it("names the terminal's own tab, with its workspace", () => {
    expect(
      creationNotice(session("herdr:b", "herdr:ws1", { windowLabel: "webBooks" }), {
        opened: "tab",
      }),
    ).toBe("Opened a tab in Herdr · webBooks");
    // The list may not show the window yet, and an app may show it: still the terminal's tab.
    expect(
      creationNotice(session("tmux:b", "tmux:$1", { shownIn: ["Ghostty"] }), { opened: "tab" }),
    ).toBe("Opened a tab in tmux");
  });

  it("names the app that opened it as a tab or window, which a Herdr attach doesn't list", () => {
    const created = session("herdr:b", "herdr:ws2");
    expect(creationNotice(created, { opened: "tab", openedIn: "iTerm2" })).toBe(
      "Opened a tab in iTerm2",
    );
    expect(creationNotice(created, { opened: "window", openedIn: "Ghostty" })).toBe(
      "Opened a new window in Ghostty",
    );
  });

  it("names a window of the terminal's own", () => {
    expect(creationNotice(session("iterm2:b", "iterm2:w2"), { opened: "window" })).toBe(
      "Opened a new window in iTerm2",
    );
  });

  it("names a split as a split, not a tab", () => {
    expect(creationNotice(session("iterm2:b", "iterm2:w1"), { opened: "split" })).toBe(
      "Opened a split pane in iTerm2",
    );
  });

  it("says nothing when the computer didn't say where it opened", () => {
    useConnectionsStore.setState({ byComputer: {} });
    useConnectionsStore.getState().patch("computer", () => ({
      sessions: [session("tmux:b", "tmux:$2")],
    }));
    announceCreated("computer", { sessionId: "tmux:b" });
    expect(useConnectionsStore.getState().byComputer.computer?.toast).toBeUndefined();
    announceCreated("computer", { sessionId: "tmux:b", opened: "window", openedIn: "Ghostty" });
    expect(useConnectionsStore.getState().byComputer.computer?.toast).toBe(
      "Opened a new window in Ghostty",
    );
  });
});
