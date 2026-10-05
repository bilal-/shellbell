import { beforeEach, describe, expect, it, vi } from "vitest";

/** `store/computers.ts` pulls in `expo-sqlite/kv-store`, which (like `react-native` itself)
 *  cannot load outside a real Metro/RN toolchain -- this mock is the seam, same pattern as
 *  `manager.test.ts`. */
const persisted: string[] = [];
vi.mock("expo-sqlite/kv-store", () => ({
  default: {
    getItemSync: () => null,
    setItemSync: (_key: string, value: string) => {
      persisted.push(value);
    },
  },
}));

describe("useUiStore font size (review I5: persist only on pinch-end, not every frame)", () => {
  beforeEach(() => {
    vi.resetModules();
    persisted.length = 0;
  });

  it("setFontSize(n, {persist:false}) updates state without touching storage", async () => {
    const { useUiStore } = await import("../src/store/computers");
    useUiStore.getState().setFontSize(20, { persist: false });
    expect(useUiStore.getState().fontSize).toBe(20);
    expect(persisted).toHaveLength(0);
  });

  it("commitFontSize() persists the current state", async () => {
    const { useUiStore } = await import("../src/store/computers");
    useUiStore.getState().setFontSize(20, { persist: false });
    useUiStore.getState().commitFontSize();
    expect(persisted).toHaveLength(1);
    expect(JSON.parse(persisted[0] ?? "{}")).toMatchObject({ fontSize: 20 });
  });

  it("setFontSize(n) with no options (the settings stepper) still persists immediately", async () => {
    const { useUiStore } = await import("../src/store/computers");
    useUiStore.getState().setFontSize(16);
    expect(persisted).toHaveLength(1);
  });

  it("a full pinch gesture -- many onUpdate frames, one onEnd -- persists exactly once", async () => {
    const { useUiStore } = await import("../src/store/computers");
    for (const n of [13, 14, 15, 16]) useUiStore.getState().setFontSize(n, { persist: false });
    expect(persisted).toHaveLength(0);
    useUiStore.getState().commitFontSize();
    expect(persisted).toHaveLength(1);
    expect(useUiStore.getState().fontSize).toBe(16);
  });

  it("clamps to [5, 24] the same way regardless of the persist option", async () => {
    const { useUiStore } = await import("../src/store/computers");
    useUiStore.getState().setFontSize(999, { persist: false });
    expect(useUiStore.getState().fontSize).toBe(24);
    useUiStore.getState().setFontSize(0, { persist: false });
    expect(useUiStore.getState().fontSize).toBe(5);
  });
});
