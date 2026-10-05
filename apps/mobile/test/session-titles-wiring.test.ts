import { describe, expect, it, vi } from "vitest";
import { onSessionsMessage } from "../src/net/manager";
import { lookupSessionTitle, type TitleStorage } from "../src/notifications/sessionTitles";

// `manager.ts` pulls in `react-native` (`AppState`) and, via `store/computers.ts`,
// `expo-sqlite/kv-store` — neither runs under vitest/node. Same seam as `manager.test.ts`.
vi.mock("react-native", () => ({
  AppState: {
    currentState: "active",
    addEventListener: () => ({ remove: () => {} }),
  },
}));

vi.mock("expo-sqlite/kv-store", () => ({
  default: {
    getItemSync: () => null,
    setItemSync: () => {},
  },
}));

vi.mock("../src/identity/keys", () => ({
  loadPairSecret: vi.fn(),
}));

function memory(): TitleStorage {
  const m = new Map<string, string>();
  return { getItemSync: (k) => m.get(k) ?? null, setItemSync: (k, v) => void m.set(k, v) };
}

describe("sessions message persists titles (spec 2026-09-20 §5)", () => {
  it("writes every session's title for later notification lookup", () => {
    const st = memory();
    onSessionsMessage(
      "fp1",
      [
        { id: "s1", title: "claude-code", backend: "herdr" },
        { id: "s2", title: "build", backend: "tmux" },
      ],
      st,
    );
    expect(lookupSessionTitle("fp1", "s1", st)?.title).toBe("claude-code");
    expect(lookupSessionTitle("fp1", "s2", st)?.backend).toBe("tmux");
  });
});
