import { afterEach, describe, expect, it, vi } from "vitest";

const deps = vi.hoisted(() => ({
  request: vi.fn(),
  claimView: vi.fn(),
  send: vi.fn(),
  online: true,
}));
vi.mock("../src/net/manager", () => ({
  connectionManager: {
    get: () => ({
      activeRoute: "direct",
      get online() {
        return deps.online;
      },
      request: deps.request,
      send: deps.send,
      newReqId: () => "fixture-request",
      testTransport() {},
    }),
    claimView: deps.claimView,
  },
}));
vi.mock("../src/store/connections", () => ({
  useConnectionsStore: {
    getState: () => ({
      read: () => ({
        status: "online",
        sessions: [{ id: "existing-session" }],
        hello: { backends: [{ name: "iterm2", capabilities: { createSession: true } }] },
      }),
    }),
  },
}));

import { qualifyTransport } from "../src/net/transport-qualification";

afterEach(() => {
  deps.online = true;
  vi.useRealTimers();
  vi.unstubAllEnvs();
  vi.clearAllMocks();
});
describe("owner device qualification isolation", () => {
  it("requires an owner build before creating a session", async () => {
    vi.stubEnv("EXPO_PUBLIC_SHELLBELL_DIRECT", "0");
    await expect(
      qualifyTransport("computer", new AbortController().signal, () => {}),
    ).rejects.toThrow("Owner build required");
    expect(deps.request).not.toHaveBeenCalled();
  });
  it("never types into an existing session returned by a faulty creation response", async () => {
    vi.stubEnv("EXPO_PUBLIC_SHELLBELL_DIRECT", "1");
    deps.request.mockResolvedValue({ type: "ack", ok: true, sessionId: "existing-session" });
    await expect(
      qualifyTransport("computer", new AbortController().signal, () => {}),
    ).rejects.toThrow("Fixture did not create a new session");
    expect(deps.request).toHaveBeenCalledOnce();
    expect(deps.request.mock.calls[0]![0].type).toBe("session.create");
    expect(deps.send).not.toHaveBeenCalled();
    expect(deps.claimView).not.toHaveBeenCalled();
  });

  it("waits for connectivity before closing its owned fixture after cancellation", async () => {
    vi.useFakeTimers();
    vi.stubEnv("EXPO_PUBLIC_SHELLBELL_DIRECT", "1");
    const controller = new AbortController();
    const release = vi.fn();
    deps.request.mockResolvedValue({ type: "ack", ok: true, sessionId: "owned-fixture" });
    deps.claimView.mockImplementation(() => {
      deps.online = false;
      controller.abort();
      return { release };
    });
    const pending = qualifyTransport("computer", controller.signal, () => {});
    const rejection = expect(pending).rejects.toThrow("Qualification cancelled");
    await vi.waitFor(() => expect(deps.claimView).toHaveBeenCalled());
    await vi.advanceTimersByTimeAsync(100);
    expect(release).toHaveBeenCalledOnce();
    expect(deps.send).not.toHaveBeenCalled();
    deps.online = true;
    await vi.advanceTimersByTimeAsync(100);
    await rejection;
    expect(deps.send).toHaveBeenCalledExactlyOnceWith({
      type: "input.line",
      reqId: "fixture-request",
      sessionId: "owned-fixture",
      text: "exit",
    });
  });
});
