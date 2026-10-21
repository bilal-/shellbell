import { expect, it, vi } from "vitest";

it("loads native replay and the screen stream without Intl.Segmenter", async () => {
  vi.resetModules();
  vi.stubGlobal("Intl", Object.create(Intl, { Segmenter: { value: undefined } }));
  try {
    await expect(import("../src/terminal/vt-replay-log")).resolves.toHaveProperty(
      "VtReplayLog",
      expect.any(Function),
    );
    await expect(import("../src/net/mobile-screen-stream")).resolves.toHaveProperty(
      "MobileScreenStream",
      expect.any(Function),
    );
  } finally {
    vi.unstubAllGlobals();
  }
});
