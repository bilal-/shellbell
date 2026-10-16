import type { BackendName, CreateWhere } from "@shellbell/protocol";
import { describe, expect, it, vi } from "vitest";
import { BackendRegistry } from "../src/backends/registry.js";
import { NotShownOnComputer, type TerminalBackend } from "../src/backends/types.js";
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
          return `${host.id}-session`;
        },
      },
    );
  return { registry, backend, createSession, hosted };
}

describe("phone-created sessions open on the computer", () => {
  it("opens a plain tmux request in iTerm2 before Ghostty", async () => {
    const { registry, createSession, hosted } = setup([{ id: "ghostty" }, { id: "iterm2" }]);
    expect(await registry.createSession({ kind: "tab", backend: "tmux" })).toBe(
      "tmux:iterm2-session",
    );
    expect(hosted).toEqual(["iterm2"]);
    expect(createSession).not.toHaveBeenCalled();
  });

  it("falls back to Ghostty when iTerm2 cannot open a window", async () => {
    const { registry, hosted } = setup([{ id: "iterm2", available: false }, { id: "ghostty" }]);
    expect(await registry.createSession({ kind: "tab", backend: "tmux" })).toBe(
      "tmux:ghostty-session",
    );
    expect(hosted).toEqual(["ghostty"]);
  });

  it("routes a plain Herdr request through a desktop window too", async () => {
    const { registry, createSession, hosted } = setup([{ id: "ghostty" }], "herdr");
    expect(await registry.createSession({ kind: "tab", backend: "herdr" })).toBe(
      "herdr:ghostty-session",
    );
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
    expect(await registry.createSession({ kind: "tab", backend: "iterm2" })).toMatch(/^iterm2:/);
    await registry.createSession({ kind: "split", sessionId: "iterm2:A", direction: "vertical" });
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
          create: async () => "id",
        },
      );
    registry.registerHostedLauncher(
      { backend: "tmux", host: "iterm2", label: "iTerm2" },
      { available: () => false, create: async () => "id" },
    );
    expect(registry.launchIssues()).toEqual([
      { backend: "herdr", reason: "herdr does not match (iterm2)" },
    ]);
    attachable = true;
    expect(registry.launchIssues()).toEqual([]);
  });
});
