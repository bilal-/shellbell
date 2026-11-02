import { beforeEach, describe, expect, it, vi } from "vitest";

const saved = new Map<string, string>();
vi.mock("expo-sqlite/kv-store", () => ({
  default: {
    getItemSync: (key: string) => saved.get(key) ?? null,
    setItemSync: (key: string, value: string) => void saved.set(key, value),
  },
}));

const KEY = "shellbell.chosen-modes.v1";
const load = async () => (await import("../src/store/chosen-modes")).useChosenModes;

beforeEach(() => {
  vi.resetModules();
  saved.clear();
});

describe("remembered Chat or Terminal pick", () => {
  it("keeps a pick across a restart, keyed by computer, session and terminal instance", async () => {
    const first = await load();
    first.getState().choose("f1", "tmux:a", "one", "terminal");
    first.getState().choose("f2", "tmux:a", "one", "chat");
    vi.resetModules();
    const store = await load();
    expect(store.getState().entries).toEqual({});
    store.getState().hydrate();
    const { chosenModeKey } = await import("../src/store/chosen-modes");
    expect(store.getState().entries).toEqual({
      [chosenModeKey("f1", "tmux:a", "one")]: "terminal",
      [chosenModeKey("f2", "tmux:a", "one")]: "chat",
    });
    expect(store.getState().entries[chosenModeKey("f1", "tmux:a", "two")]).toBeUndefined();
  });

  it("reads what was saved before its first change, so an early pick doesn't erase it", async () => {
    saved.set(KEY, JSON.stringify([["f1", "tmux:a", "one", "terminal"]]));
    const store = await load();
    store.getState().choose("f1", "tmux:b", "two", "chat");
    expect(JSON.parse(saved.get(KEY)!)).toEqual([
      ["f1", "tmux:a", "one", "terminal"],
      ["f1", "tmux:b", "two", "chat"],
    ]);
  });

  it("forgets sessions a complete list no longer has, or that a new terminal replaced", async () => {
    const store = await load();
    store.getState().choose("f1", "tmux:a", "one", "terminal");
    store.getState().choose("f1", "tmux:b", "one", "chat");
    store.getState().choose("f1", "tmux:c", "one", "chat");
    store.getState().choose("f2", "tmux:a", "one", "terminal");
    store
      .getState()
      .pruneSessions("f1", [
        { id: "tmux:a", instance: "one" },
        { id: "tmux:b", instance: "two" },
        { id: "tmux:d" },
      ]);
    expect(JSON.parse(saved.get(KEY)!)).toEqual([
      ["f1", "tmux:a", "one", "terminal"],
      ["f2", "tmux:a", "one", "terminal"],
    ]);
  });

  it("forgets every pick for an unpaired computer", async () => {
    const store = await load();
    store.getState().choose("f1", "tmux:a", "one", "terminal");
    store.getState().choose("f2", "tmux:a", "one", "chat");
    store.getState().forgetComputer("f1");
    expect(JSON.parse(saved.get(KEY)!)).toEqual([["f2", "tmux:a", "one", "chat"]]);
  });

  it("moves a changed pick to the newest place and drops the oldest past the limit", async () => {
    const { CHOSEN_MODES_MAX } = await import("../src/store/chosen-modes");
    const store = await load();
    for (let i = 0; i < CHOSEN_MODES_MAX; i++)
      store.getState().choose("f1", `tmux:${i}`, "one", "chat");
    store.getState().choose("f1", "tmux:0", "one", "terminal");
    store.getState().choose("f1", "tmux:new", "one", "chat");
    const list = JSON.parse(saved.get(KEY)!) as string[][];
    expect(list).toHaveLength(CHOSEN_MODES_MAX);
    expect(list[0]).toEqual(["f1", "tmux:2", "one", "chat"]);
    expect(list.at(-2)).toEqual(["f1", "tmux:0", "one", "terminal"]);
    expect(list.at(-1)).toEqual(["f1", "tmux:new", "one", "chat"]);
  });

  it("ignores saved data it doesn't recognise", async () => {
    saved.set(
      KEY,
      JSON.stringify([["f1", "tmux:a", "one", "reading"], ["f1", 2, "one", "chat"], "junk"]),
    );
    const store = await load();
    store.getState().hydrate();
    expect(store.getState().entries).toEqual({});
    saved.set(KEY, "{not json");
    vi.resetModules();
    const again = await load();
    again.getState().hydrate();
    expect(again.getState().entries).toEqual({});
  });
});
