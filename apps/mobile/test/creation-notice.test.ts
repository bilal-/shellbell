import { describe, expect, it, vi } from "vitest";

vi.mock("expo-sqlite/kv-store", () => ({
  default: { getItemSync: () => null, setItemSync() {} },
}));

const { announceCreated, creationNotice } = await import("../src/util/creation-notice");
const { useConnectionsStore } = await import("../src/store/connections");

const session = (id: string, windowId: string, extra: object = {}) =>
  ({ id, backend: id.split(":")[0], windowId, ...extra }) as never;

describe("where a new session went", () => {
  it("names a tab in a window that already had sessions, with its workspace", () => {
    const before = [session("herdr:a", "herdr:ws1")];
    expect(
      creationNotice(
        session("herdr:b", "herdr:ws1", { windowLabel: "webBooks" }),
        { opened: "tab" },
        before,
      ),
    ).toBe("Opened a tab in Herdr · webBooks");
    expect(
      creationNotice(session("tmux:b", "tmux:$1"), { opened: "tab" }, [
        session("tmux:a", "tmux:$1"),
      ]),
    ).toBe("Opened a tab in tmux");
  });

  it("names the app whose window took a new session as a tab", () => {
    // A new tmux session of its own, shown as a tab of iTerm2's open window.
    expect(
      creationNotice(session("tmux:b", "tmux:$2", { shownIn: ["iTerm2"] }), { opened: "tab" }, [
        session("tmux:a", "tmux:$1"),
      ]),
    ).toBe("Opened a tab in iTerm2");
  });

  it("names the app the computer opened it in, which a Herdr attach doesn't list", () => {
    const created = session("herdr:b", "herdr:ws2");
    expect(creationNotice(created, { opened: "tab", openedIn: "iTerm2" }, [])).toBe(
      "Opened a tab in iTerm2",
    );
    expect(creationNotice(created, { opened: "window", openedIn: "Ghostty" }, [])).toBe(
      "Opened a new window in Ghostty",
    );
  });

  it("names a new window, by the app that shows it when known", () => {
    expect(
      creationNotice(session("tmux:b", "tmux:$2", { shownIn: ["Ghostty"] }), { opened: "window" }, [
        session("tmux:a", "tmux:$1"),
      ]),
    ).toBe("Opened a new window in Ghostty");
    expect(creationNotice(session("iterm2:b", "iterm2:w2"), { opened: "window" }, [])).toBe(
      "Opened a new window in iTerm2",
    );
    // A window is a window even when its id matches a listed one's.
    expect(
      creationNotice(session("tmux:b", "tmux:$1"), { opened: "window" }, [
        session("tmux:a", "tmux:$1"),
      ]),
    ).toBe("Opened a new window in tmux");
  });

  it("names a split as a split, not a tab", () => {
    expect(
      creationNotice(session("iterm2:b", "iterm2:w1"), { opened: "split" }, [
        session("iterm2:a", "iterm2:w1"),
      ]),
    ).toBe("Opened a split pane in iTerm2");
  });

  it("says nothing when the computer didn't say where it opened", () => {
    useConnectionsStore.setState({ byComputer: {} });
    useConnectionsStore.getState().patch("computer", () => ({
      sessions: [session("tmux:b", "tmux:$2")],
    }));
    announceCreated("computer", { sessionId: "tmux:b" });
    expect(useConnectionsStore.getState().byComputer.computer?.toast).toBeUndefined();
    announceCreated("computer", { sessionId: "tmux:b", opened: "window" });
    expect(useConnectionsStore.getState().byComputer.computer?.toast).toBe(
      "Opened a new window in tmux",
    );
  });
});
