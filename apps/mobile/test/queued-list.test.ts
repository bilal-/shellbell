import { act, createElement } from "react";
import { createRoot } from "test-renderer";
import { expect, it, vi } from "vitest";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;

vi.mock("react-native", () => ({ Text: "Text", View: "View" }));
vi.mock("../src/conversation/motion", () => ({
  Fade: (props: { children?: unknown }) => createElement("Fade", null, props.children as never),
}));

const { QueuedList } = await import("../src/conversation/QueuedList");

const render = async (queued: object[] | undefined) => {
  const root = createRoot();
  await act(async () =>
    root.render(createElement(QueuedList, { queued: queued as never, agent: "claude" })),
  );
  const lines = root.container.queryAll((n) => n.type === "Text").map((n) => n.children.join(""));
  return { root, lines };
};

it("lists up to three queued messages for the agent, then counts the rest", async () => {
  const { root, lines } = await render([
    { text: "also run lint" },
    { attachment: true },
    { text: "then commit", attachment: true },
    { text: "fourth" },
    { text: "fifth" },
  ]);
  expect(lines).toEqual([
    "Queued for Claude",
    "also run lint",
    "Queued attachment",
    "then commit · with attachment",
    "+2 more",
  ]);
  // Inside its fade, which stands still under Reduce Motion.
  expect(root.container.queryAll((n) => n.type === "Fade")).toHaveLength(1);
  await act(async () => root.unmount());
});

it("shows nothing at all when nothing is reported, never 'nothing queued'", async () => {
  for (const queued of [undefined, []]) {
    const { root, lines } = await render(queued);
    expect(lines).toEqual([]);
    await act(async () => root.unmount());
  }
});
