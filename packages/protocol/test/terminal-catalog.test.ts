import { describe, expect, it } from "vitest";
import {
  BackendCatalogSchema,
  BackendNameSchema,
  CreateWhereSchema,
  parseInner,
  parseInnerLoose,
} from "../src/index.js";
import { parseInner as legacyParseInner } from "./fixtures/legacy-protocol-20260921/inner.js";

const capabilities = {
  subscribe: true,
  prompts: false,
  createSession: true,
  focus: false,
  history: false,
  absoluteLines: false,
};
describe("extensible terminal catalog", () => {
  it("bounds adapter namespaces and accepts a new local adapter creation request", () => {
    expect(BackendNameSchema.safeParse("kitty").success).toBe(true);
    for (const id of ["", "../kitty", "x:y", "x;open", "A", "x".repeat(33), "bad\nname"])
      expect(BackendNameSchema.safeParse(id).success).toBe(false);
    expect(
      parseInner({ type: "session.create", reqId: "r", in: { kind: "tab", backend: "kitty" } }),
    ).toMatchObject({ in: { backend: "kitty" } });
    expect(
      CreateWhereSchema.safeParse({
        kind: "tab",
        backend: "tmux",
        host: "ghostty",
        windowId: "tmux:$0",
      }).success,
    ).toBe(false);
  });
  it("preserves the legacy hello bound while exposing more adapters to new phones", () => {
    const catalog = Array.from({ length: 8 }, (_, i) => ({
      name: `adapter-${i}`,
      label: `Adapter ${i}`,
      capabilities,
      connected: true,
      launchable: false,
    }));
    const hello = {
      type: "hello",
      agentVersion: "0.2.0",
      computerName: "Computer",
      accent: "emerald",
      backends: [{ name: "tmux", capabilities }],
      backendCatalog: catalog,
    };
    expect(parseInner(hello)).toMatchObject({ backendCatalog: catalog });
    expect(parseInnerLoose(hello)).toMatchObject({ backendCatalog: catalog });
    expect(legacyParseInner(hello)).toMatchObject({ backends: hello.backends });
    expect(BackendCatalogSchema.safeParse([...catalog, catalog[0]]).success).toBe(false);
    expect(
      BackendCatalogSchema.safeParse(
        Array.from({ length: 33 }, (_, i) => ({ ...catalog[0], name: `adapter-${i}` })),
      ).success,
    ).toBe(false);
  });
});
