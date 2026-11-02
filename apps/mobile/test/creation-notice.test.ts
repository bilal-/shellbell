import { describe, expect, it, vi } from "vitest";

vi.mock("expo-sqlite/kv-store", () => ({
  default: { getItemSync: () => null, setItemSync() {} },
}));

const { creationNotice } = await import("../src/util/creation-notice");

const session = (id: string, windowId: string, extra: object = {}) =>
  ({ id, backend: id.split(":")[0], windowId, ...extra }) as never;

describe("where a new session went", () => {
  it("names a tab in a window that already had sessions, with its workspace", () => {
    const before = [session("herdr:a", "herdr:ws1")];
    expect(
      creationNotice(session("herdr:b", "herdr:ws1", { windowLabel: "webBooks" }), before),
    ).toBe("Opened a tab in Herdr · webBooks");
    expect(creationNotice(session("tmux:b", "tmux:$1"), [session("tmux:a", "tmux:$1")])).toBe(
      "Opened a tab in tmux",
    );
  });

  it("names a new window, by the app that shows it when known", () => {
    expect(
      creationNotice(session("tmux:b", "tmux:$2", { shownIn: ["Ghostty"] }), [
        session("tmux:a", "tmux:$1"),
      ]),
    ).toBe("Opened a new window in Ghostty");
    expect(creationNotice(session("iterm2:b", "iterm2:w2"), [])).toBe(
      "Opened a new window in iTerm2",
    );
  });
});
