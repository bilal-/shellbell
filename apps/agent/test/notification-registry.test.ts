import { describe, expect, it } from "vitest";
import { BackendRegistry } from "../src/backends/registry.js";
import { createLogger } from "../src/log.js";
import type { NotificationFacts } from "../src/notification-context.js";
import { FakeBackend } from "./fakes/fake-backend.js";

describe("notification facts ownership", () => {
  it("prefixes facts and rejects a retired backend's asynchronous result", async () => {
    const registry = new BackendRegistry(createLogger({ stdout: false }));
    let finish!: (value: NotificationFacts) => void;
    const backend = Object.assign(new FakeBackend("tmux"), {
      notificationFacts: () =>
        new Promise<NotificationFacts>((resolve) => {
          finish = resolve;
        }),
    });
    registry.add(backend);
    const pending = registry.notificationFacts("tmux:1");
    registry.remove("tmux");
    finish({ sessionId: "1", revision: "1", sessionLabel: "Pane 1", locality: "local" });
    expect(await pending).toBeUndefined();
    registry.add(
      Object.assign(new FakeBackend("tmux"), {
        notificationFacts: async () => ({
          sessionId: "1",
          revision: "1",
          sessionLabel: "Pane 1",
          locality: "local" as const,
        }),
      }),
    );
    expect(await registry.notificationFacts("tmux:1")).toMatchObject({
      sessionId: "tmux:1",
      locality: "local",
    });
    await registry.close();
  });
});
