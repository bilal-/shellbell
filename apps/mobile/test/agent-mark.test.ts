import { act, createElement } from "react";
import { createRoot } from "test-renderer";
import { expect, it, vi } from "vitest";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;

vi.mock("react-native", () => ({ Text: "Text", View: "View" }));
vi.mock("../src/ui/AppIcon", () => ({ AppIcon: () => null }));

const { AGENT_HARNESSES } = await import("../src/agents/registry");
const { AgentMark } = await import("../src/agents/AgentMark");
const { contrastOnBlack } = await import("../src/theme/contrast");

it("draws every agent's mark in a colour that reads at AA contrast on black", async () => {
  for (const kind of Object.keys(AGENT_HARNESSES)) {
    const root = createRoot();
    await act(async () => root.render(createElement(AgentMark, { kind })));
    const text = root.container.queryAll((n) => n.type === "Text")[0]!;
    const color = (text.props.style as { color: string }).color;
    expect(contrastOnBlack(color), `${kind} ${color}`).toBeGreaterThanOrEqual(4.5);
    await act(async () => root.unmount());
  }
});
