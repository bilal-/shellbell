import type { BackendName, CreateWhere } from "@shellbell/protocol";
import { describe, expect, it, vi } from "vitest";
import { BackendRegistry } from "../src/backends/registry.js";
import { NotShownOnComputer, SessionGone, type TerminalBackend } from "../src/backends/types.js";
import { createLogger } from "../src/log.js";
import { FakeBackend } from "./fakes/fake-backend.js";

const log = createLogger({ stdout: false });

/** A phone must never create a session that only the phone can see. */
function setup(hosts: { id: string; available?: boolean }[], engine: BackendName = "tmux") {
  const registry = new BackendRegistry(log);
  const backend = new FakeBackend(engine);
  const createSession = vi.spyOn(backend, "createSession");
  registry.add(backend);
  const hosted: string[] = [];
  for (const host of hosts)
    registry.registerHostedLauncher(
      { backend: engine, host: host.id, label: host.id },
      {
        available: () => host.available !== false,
        create: async () => {
          hosted.push(host.id);
          return { sessionId: `${host.id}-session`, opened: "window" as const };
        },
      },
    );
  return { registry, backend, createSession, hosted };
}

describe("phone-created sessions open on the computer", () => {
  it("preserves the initial grid through default host selection and native new windows", async () => {
    const initialSize = { cols: 54, rows: 40 };
    const { registry, backend } = setup([], "herdr");
    const create = vi.fn(async () => ({ sessionId: "new-terminal", opened: "window" as const }));
    registry.registerHostedLauncher(
      { backend: "herdr", host: "ghostty", label: "Ghostty" },
      { available: () => true, create },
    );
    await registry.createSession({ kind: "tab", backend: "herdr", initialSize });
    expect(create).toHaveBeenCalledWith(backend, undefined, initialSize);
    const native = setup([], "iterm2");
    await native.registry.createSession({ kind: "tab", backend: "iterm2", initialSize });
    expect(native.createSession).toHaveBeenCalledWith({
      kind: "tab",
      backend: "iterm2",
      windowId: undefined,
      initialSize,
    });
    await registry.close();
    await native.registry.close();
  });

  it("opens a plain tmux request in iTerm2 before Ghostty", async () => {
    const { registry, createSession, hosted } = setup([{ id: "ghostty" }, { id: "iterm2" }]);
    expect(await registry.createSession({ kind: "tab", backend: "tmux" })).toEqual({
      sessionId: "tmux:iterm2-session",
      opened: "window",
      openedIn: "iterm2",
    });
    expect(hosted).toEqual(["iterm2"]);
    expect(createSession).not.toHaveBeenCalled();
  });

  it("falls back to Ghostty when iTerm2 cannot open a window", async () => {
    const { registry, hosted } = setup([{ id: "iterm2", available: false }, { id: "ghostty" }]);
    expect(await registry.createSession({ kind: "tab", backend: "tmux" })).toEqual({
      sessionId: "tmux:ghostty-session",
      opened: "window",
      openedIn: "ghostty",
    });
    expect(hosted).toEqual(["ghostty"]);
  });

  it("routes a plain Herdr request through a desktop window too", async () => {
    const { registry, createSession, hosted } = setup([{ id: "ghostty" }], "herdr");
    expect(await registry.createSession({ kind: "tab", backend: "herdr" })).toEqual({
      sessionId: "herdr:ghostty-session",
      opened: "window",
      openedIn: "ghostty",
    });
    expect(hosted).toEqual(["ghostty"]);
    expect(createSession).not.toHaveBeenCalled();
  });

  it.each(["tmux", "herdr"] as const)(
    "refuses a plain %s request when no terminal app can show it, without starting anything",
    async (engine) => {
      const { registry, createSession, hosted } = setup(
        [{ id: "ghostty", available: false }],
        engine,
      );
      const start = vi.fn();
      registry.registerSessionLauncher(engine, { available: () => true, start });
      const refusal = registry.createSession({ kind: "tab", backend: engine });
      await expect(refusal).rejects.toBeInstanceOf(NotShownOnComputer);
      await expect(refusal).rejects.toThrow("No terminal app on this computer can show");
      expect(createSession).not.toHaveBeenCalled();
      expect(start).not.toHaveBeenCalled();
      expect(hosted).toEqual([]);
    },
  );

  it("refuses an adapter that has no desktop window to show its new sessions", async () => {
    const { registry, createSession } = setup([], "example");
    await expect(registry.createSession({ kind: "tab", backend: "example" })).rejects.toThrow(
      NotShownOnComputer,
    );
    expect(createSession).not.toHaveBeenCalled();
  });

  it("keeps native iTerm2 tabs and splits, which iTerm2 shows itself", async () => {
    const { registry, backend, createSession } = setup([], "iterm2");
    backend.addSession("A", {});
    expect(await registry.createSession({ kind: "tab", backend: "iterm2" })).toMatchObject({
      sessionId: expect.stringMatching(/^iterm2:/),
      opened: "window",
    });
    expect(
      await registry.createSession({ kind: "split", sessionId: "iterm2:A", direction: "vertical" }),
    ).toMatchObject({ opened: "split" });
    expect(createSession).toHaveBeenCalledTimes(2);
  });

  it("keeps an explicitly chosen terminal app", async () => {
    const { registry, hosted } = setup([{ id: "iterm2" }, { id: "ghostty" }]);
    await registry.createSession({ kind: "tab", backend: "tmux", host: "ghostty" });
    expect(hosted).toEqual(["ghostty"]);
  });

  it("adds to an existing tmux session only while a desktop client shows it", async () => {
    const { registry, backend, createSession } = setup([]);
    backend.addSession("%1", {});
    const asked: CreateWhere[] = [];
    let shown = false;
    (backend as TerminalBackend).shownOnComputer = async (where) => {
      asked.push(where);
      return shown;
    };
    const split = { kind: "split", sessionId: "tmux:%1", direction: "vertical" } as const;
    const window = { kind: "tab", backend: "tmux", windowId: "tmux:$1" } as const;
    await expect(registry.createSession(split)).rejects.toThrow(NotShownOnComputer);
    await expect(registry.createSession(window)).rejects.toThrow(NotShownOnComputer);
    expect(createSession).not.toHaveBeenCalled();
    expect(asked).toEqual([
      { kind: "split", sessionId: "%1", direction: "vertical" },
      { kind: "tab", backend: "tmux", windowId: "$1" },
    ]);
    shown = true;
    await registry.createSession(split);
    await registry.createSession(window);
    expect(createSession).toHaveBeenCalledTimes(2);
  });

  it("refuses splits for an engine that cannot tell whether a desktop client shows them", async () => {
    const { registry, backend, createSession } = setup([], "herdr");
    backend.addSession("term", {});
    await expect(
      registry.createSession({ kind: "split", sessionId: "herdr:term", direction: "vertical" }),
    ).rejects.toThrow(NotShownOnComputer);
    await expect(
      registry.createSession({ kind: "tab", backend: "herdr", windowId: "herdr:w1" }),
    ).rejects.toThrow(NotShownOnComputer);
    expect(createSession).not.toHaveBeenCalled();
  });

  it("opens an iTerm2 window when the focused window it named closed before its tab", async () => {
    const { registry, backend, createSession } = setup([], "iterm2");
    Object.assign(backend, { focusedWindow: async () => "w-closed" });
    createSession.mockImplementation(async (where: CreateWhere) => {
      if (where.kind === "tab" && where.windowId === "w-closed")
        throw new Error("create tab failed");
      return "new-window-session";
    });
    expect(
      await registry.createSession({ kind: "tab", backend: "iterm2", near: "focused" }),
    ).toEqual({ sessionId: "iterm2:new-window-session", opened: "window" });
    expect(createSession).toHaveBeenLastCalledWith({
      kind: "tab",
      backend: "iterm2",
      windowId: undefined,
    });
    await registry.close();
  });

  it("opens no iTerm2 window beside a tab that may still be opening in a window still open", async () => {
    const { registry, backend, createSession } = setup([], "iterm2");
    backend.addSession("existing", {});
    Object.assign(backend, { focusedWindow: async () => "w" });
    // Too slow to answer: iTerm2 may yet make the tab, so a window would be a second session.
    createSession.mockRejectedValue(new Error("iTerm2 request timed out"));
    await expect(
      registry.createSession({ kind: "tab", backend: "iterm2", near: "focused" }),
    ).rejects.toThrow(/timed out/);
    expect(createSession).toHaveBeenCalledOnce();
    await registry.close();
  });

  describe("tabs", () => {
    /** An engine that can say where the focused session's window is and whether it's shown. */
    function engine(name: BackendName, hosts = [{ id: "ghostty" }]) {
      const f = setup(hosts, name);
      const state = { focused: "$1" as string | undefined, shown: [true] as boolean[] };
      const shown = vi.fn(async (_where: CreateWhere) => state.shown.shift() ?? false);
      const discard = vi.fn(async (_id: string) => {});
      Object.assign(f.backend, {
        shownOnComputer: shown,
        focusedWindow: async () => state.focused,
        discardSession: discard,
      });
      f.createSession.mockResolvedValue("%7");
      return { ...f, state, shown, discard };
    }

    it.each(["tmux", "herdr"] as const)(
      "opens a %s tab next to the focused session when a desktop client shows it",
      async (name) => {
        const f = engine(name);
        f.state.shown = [true, true];
        expect(
          await f.registry.createSession({ kind: "tab", backend: name, near: "focused" }),
        ).toEqual({ sessionId: `${name}:%7`, opened: "tab" });
        expect(f.createSession).toHaveBeenCalledExactlyOnceWith({
          kind: "tab",
          backend: name,
          windowId: "$1",
        });
        expect(f.hosted).toEqual([]);
      },
    );

    it("opens a window when nothing is shown to add a tab to", async () => {
      const f = engine("tmux");
      f.state.focused = undefined;
      expect(
        await f.registry.createSession({ kind: "tab", backend: "tmux", near: "focused" }),
      ).toEqual({ sessionId: "tmux:ghostty-session", opened: "window", openedIn: "ghostty" });
      expect(f.createSession).not.toHaveBeenCalled();
      expect(f.hosted).toEqual(["ghostty"]);
    });

    it("closes the tab and opens a window when its client detaches between check and create", async () => {
      const f = engine("herdr");
      f.state.shown = [true, false];
      expect(
        await f.registry.createSession({ kind: "tab", backend: "herdr", windowId: "herdr:$1" }),
      ).toEqual({ sessionId: "herdr:ghostty-session", opened: "window", openedIn: "ghostty" });
      expect(f.createSession).toHaveBeenCalledOnce();
      expect(f.discard).toHaveBeenCalledExactlyOnceWith("%7");
      expect(f.hosted).toEqual(["ghostty"]);
    });

    it("opens no window beside a tab it couldn't close again, and says so", async () => {
      const f = engine("herdr");
      f.state.shown = [true, false];
      f.discard.mockRejectedValue(new Error("tab.close failed"));
      const refusal = f.registry.createSession({
        kind: "tab",
        backend: "herdr",
        windowId: "herdr:$1",
      });
      await expect(refusal).rejects.toBeInstanceOf(NotShownOnComputer);
      await expect(refusal).rejects.toThrow(/could not be closed/);
      expect(f.hosted).toEqual([]);
    });

    it("refuses a tab in a window that is no longer shown, without creating anything", async () => {
      const f = engine("tmux");
      f.state.shown = [false];
      const refusal = f.registry.createSession({
        kind: "tab",
        backend: "tmux",
        windowId: "tmux:$1",
      });
      await expect(refusal).rejects.toBeInstanceOf(NotShownOnComputer);
      await expect(refusal).rejects.toThrow(/isn't open on your computer any more/);
      expect(f.createSession).not.toHaveBeenCalled();
      expect(f.hosted).toEqual([]);
    });

    it("reports a window whose session ended as gone", async () => {
      const f = engine("tmux");
      f.shown.mockRejectedValueOnce(new SessionGone("$9"));
      await expect(
        f.registry.createSession({ kind: "tab", backend: "tmux", windowId: "tmux:$9" }),
      ).rejects.toBeInstanceOf(SessionGone);
      expect(f.createSession).not.toHaveBeenCalled();
    });

    it("opens a window for an app the owner picked, but a tab for the sheet's preselected one", async () => {
      const f = engine("tmux", [{ id: "ghostty" }, { id: "iterm2" }]);
      f.state.shown = [true, true];
      await f.registry.createSession({
        kind: "tab",
        backend: "tmux",
        host: "ghostty",
        near: "focused",
        explicit: true,
      });
      expect(f.hosted).toEqual(["ghostty"]);
      expect(f.createSession).not.toHaveBeenCalled();
      expect(
        await f.registry.createSession({
          kind: "tab",
          backend: "tmux",
          host: "ghostty",
          near: "focused",
        }),
      ).toEqual({ sessionId: "tmux:%7", opened: "tab" });
      expect(f.hosted).toEqual(["ghostty"]);
    });

    it("opens a window for a size other than Default", async () => {
      const f = engine("tmux");
      await f.registry.createSession({
        kind: "tab",
        backend: "tmux",
        near: "focused",
        initialSize: { cols: 100, rows: 40 },
      });
      expect(f.hosted).toEqual(["ghostty"]);
      expect(f.createSession).not.toHaveBeenCalled();
    });

    it("asks a host app for a tab of its focused window when the engine can't add one", async () => {
      const { registry, backend } = setup([], "herdr");
      const create = vi.fn(async () => ({ sessionId: "new-terminal", opened: "window" as const }));
      registry.registerHostedLauncher(
        { backend: "herdr", host: "iterm2", label: "iTerm2" },
        { available: () => true, create },
      );
      await registry.createSession({ kind: "tab", backend: "herdr", near: "focused" });
      expect(create).toHaveBeenCalledWith(backend, undefined, undefined, { tab: true });
      await registry.createSession({ kind: "tab", backend: "herdr" });
      expect(create).toHaveBeenLastCalledWith(backend, undefined);
    });

    it("opens an iTerm2 tab in the focused window, or a window with none open", async () => {
      const f = setup([], "iterm2");
      let focused: string | undefined = "w2";
      Object.assign(f.backend, { focusedWindow: async () => focused });
      await f.registry.createSession({ kind: "tab", backend: "iterm2", near: "focused" });
      expect(f.createSession).toHaveBeenLastCalledWith({
        kind: "tab",
        backend: "iterm2",
        windowId: "w2",
      });
      focused = undefined;
      await f.registry.createSession({ kind: "tab", backend: "iterm2", near: "focused" });
      expect(f.createSession).toHaveBeenLastCalledWith({
        kind: "tab",
        backend: "iterm2",
        windowId: undefined,
      });
    });

    it("allows Herdr splits once a desktop client shows them", async () => {
      const f = engine("herdr");
      f.backend.addSession("term", {});
      f.state.shown = [true];
      await f.registry.createSession({
        kind: "split",
        sessionId: "herdr:term",
        direction: "vertical",
      });
      expect(f.createSession).toHaveBeenCalledOnce();
    });
  });

  it("still reports a mismatched window as bad-window", async () => {
    const { registry } = setup([{ id: "iterm2" }]);
    await expect(
      registry.createSession({ kind: "tab", backend: "tmux", windowId: "iterm2:w1" }),
    ).rejects.toThrow(/bad-window/);
  });
});

describe("launch issues", () => {
  it("explains a backend whose every launch target is unavailable, once", () => {
    const registry = new BackendRegistry(log);
    registry.add(new FakeBackend("herdr"));
    let attachable = false;
    for (const host of ["iterm2", "ghostty"])
      registry.registerHostedLauncher(
        { backend: "herdr", host, label: host },
        {
          available: () => attachable,
          unavailableReason: () => (attachable ? undefined : `herdr does not match (${host})`),
          create: async () => ({ sessionId: "id", opened: "window" as const }),
        },
      );
    registry.registerHostedLauncher(
      { backend: "tmux", host: "iterm2", label: "iTerm2" },
      {
        available: () => false,
        create: async () => ({ sessionId: "id", opened: "window" as const }),
      },
    );
    expect(registry.launchIssues()).toEqual([
      { backend: "herdr", reason: "herdr does not match (iterm2)" },
    ]);
    attachable = true;
    expect(registry.launchIssues()).toEqual([]);
  });
});
